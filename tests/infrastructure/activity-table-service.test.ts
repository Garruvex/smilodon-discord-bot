import { describe, expect, it, vi } from "vitest";
import { ActivityTableService, type ActivityTableInput } from "../../src/infrastructure/activity/activity-table-service.js";
import { CampaignLobbyService } from "../../src/application/campaign/campaign-lobby-service.js";
import { CampaignCommandBus } from "../../src/application/campaign/campaign-command-bus.js";
import { StaticAdventureLibrary } from "../../src/application/campaign/adventures/static-adventure-library.js";
import { RulesetCatalog } from "../../src/application/campaign/rules/ruleset-catalog.js";
import { ManualClock } from "../../src/application/campaign/time/manual-clock.js";
import { InMemoryCampaignStore } from "../../src/infrastructure/persistence/campaign/in-memory-campaign-store.js";
import { loadStarterAdventure, starterAdventureId } from "../../src/infrastructure/campaign/starter-adventures.js";
import type { CreateGameResult, NewGame } from "../../src/infrastructure/discord/campaign/campaign-game-creator.js";
import { ruleset } from "../domain/campaign/campaign-fixtures.js";

const input: ActivityTableInput = { name: "Lantern party", adventureId: starterAdventureId, language: "en", pacing: "live", players: 3, visibility: "membersOnly", joinAsPlayer: true };

function setup(): { store: InMemoryCampaignStore; lobby: CampaignLobbyService; service: ActivityTableService; create: ReturnType<typeof vi.fn<(game: NewGame) => Promise<CreateGameResult>>>; searchMembers: ReturnType<typeof vi.fn<() => Promise<readonly { userId: string; displayName: string }[]>>>; isMember: ReturnType<typeof vi.fn<(guildId: string, userId: string) => Promise<boolean>>> } {
  const store = new InMemoryCampaignStore();
  const clock = new ManualClock(1000);
  const content = ruleset().content;
  const adventures = new StaticAdventureLibrary([{ id: starterAdventureId, editions: loadStarterAdventure() }]);
  const lobby = new CampaignLobbyService({ unitOfWork: store, bus: new CampaignCommandBus({ unitOfWork: store, rulesets: new RulesetCatalog([content]), clock }), adventures, clock, ruleset: { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} }, newId: (): string => "table-id" });
  const create = vi.fn(async (game: NewGame): Promise<CreateGameResult> => {
    const result = await lobby.create({ guildId: game.guildId, organizerId: game.organizerId, name: game.name, language: game.language, adventureId: game.adventureId ?? starterAdventureId, pacing: { preset: game.pacing }, maxPlayers: game.players, visibility: game.visibility ?? "open" });
    return result.kind === "ok" ? { kind: "created", record: result.value } : result;
  });
  const isAdmin = vi.fn((_guildId: string, userId: string): Promise<boolean> => Promise.resolve(userId === "organizer"));
  const isMember = vi.fn((_guildId: string, userId: string): Promise<boolean> => Promise.resolve(userId !== "outsider"));
  const searchMembers = vi.fn((): Promise<readonly { userId: string; displayName: string }[]> => Promise.resolve([{ userId: "player", displayName: "Player" }]));
  const service = new ActivityTableService({ unitOfWork: store, lobby, play: { setPresenceFor: vi.fn(() => Promise.resolve({ kind: "ok" as const })) }, creator: { create, modelConfigured: true }, adventures: { listForGuild: (): ReturnType<typeof adventures.list> => adventures.list() }, isAdmin, isMember, searchMembers, memberName: (_guildId, userId): Promise<string> => Promise.resolve(userId), now: (): number => clock.now(), refresh: vi.fn() });
  return { store, lobby, service, create, searchMembers, isMember };
}

describe("Activity table authorization", () => {
  it("creates through the shared creator with the authenticated identity and optionally seats the organizer", async () => {
    const { service, store, lobby, create } = setup();
    await store.transaction((tx) => tx.saveGuildSettings({ guildId: "guild", categoryId: "category", hubChannelId: "hub", hubCard: null }));
    const result = await service.create("guild", "organizer", input);
    expect(result).toEqual({ kind: "ok", value: { campaignId: "table-id", warning: null } });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ guildId: "guild", organizerId: "organizer", visibility: "membersOnly" }));
    expect((await lobby.get({ guildId: "guild", campaignId: "table-id" }))?.record.lobby.members).toMatchObject([{ userId: "organizer", status: "creating" }]);
    const host = setup();
    await host.store.transaction((tx) => tx.saveGuildSettings({ guildId: "guild", categoryId: "category", hubChannelId: "hub", hubCard: null }));
    expect((await host.service.create("guild", "organizer", { ...input, joinAsPlayer: false })).kind).toBe("ok");
    expect((await host.lobby.get({ guildId: "guild", campaignId: "table-id" }))?.record.lobby.members).toEqual([]);
  });

  it("refuses creation by a player before calling the creator", async () => {
    const { service, create } = setup();
    expect(await service.create("guild", "player", input)).toEqual({ kind: "refused", reason: "notOrganizer" });
    expect(create).not.toHaveBeenCalled();
  });

  it("does not reveal the roster or search server members to another player", async () => {
    const { service, lobby, searchMembers } = setup();
    const result = await lobby.create({ guildId: "guild", organizerId: "organizer", name: input.name, language: "en", adventureId: starterAdventureId, pacing: { preset: "live" } });
    if (result.kind !== "ok") throw new Error(result.reason);
    expect(await service.management(result.value.key, "player")).toEqual({ kind: "refused", reason: "notOrganizer" });
    expect(await service.membersForInvite(result.value.key, "player", "Pl")).toEqual({ kind: "refused", reason: "notOrganizer" });
    expect(searchMembers).not.toHaveBeenCalled();
    expect((await service.invite(result.value.key, "organizer", "outsider", "")).kind).toBe("refused");
    expect((await service.invite(result.value.key, "organizer", "player", "")).kind).toBe("ok");
    expect((await lobby.joinFromActivity(result.value.key, "player")).kind).toBe("ok");
  });
});
