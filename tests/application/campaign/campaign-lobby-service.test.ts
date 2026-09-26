import { describe, expect, it } from "vitest";

import { StaticAdventureLibrary } from "../../../src/application/campaign/adventures/static-adventure-library.js";
import { CampaignCommandBus } from "../../../src/application/campaign/campaign-command-bus.js";
import {
  CampaignLobbyService,
  type CreateCampaignInput,
  type ServiceRefusal,
  type ServiceResult,
} from "../../../src/application/campaign/campaign-lobby-service.js";
import type { CampaignKey } from "../../../src/application/campaign/ports/campaign-store.js";
import { RulesetCatalog } from "../../../src/application/campaign/rules/ruleset-catalog.js";
import { ManualClock } from "../../../src/application/campaign/time/manual-clock.js";
import { loadStarterAdventure, starterAdventureId } from "../../../src/infrastructure/campaign/starter-adventures.js";
import { InMemoryCampaignStore } from "../../../src/infrastructure/persistence/campaign/in-memory-campaign-store.js";
import { ruleset } from "../../domain/campaign/campaign-fixtures.js";

const guildId = "g-1";
const starter = loadStarterAdventure();

function setup(): { service: CampaignLobbyService; store: InMemoryCampaignStore } {
  const store = new InMemoryCampaignStore();
  const content = ruleset().content;
  const clock = new ManualClock(1_000);
  let counter = 0;
  const service = new CampaignLobbyService({
    unitOfWork: store,
    bus: new CampaignCommandBus({ unitOfWork: store, rulesets: new RulesetCatalog([content]), clock }),
    adventures: new StaticAdventureLibrary([{ id: starterAdventureId, editions: starter }]),
    clock,
    ruleset: { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} },
    newId: (): string => `camp-${++counter}`,
  });
  return { service, store };
}

const input = (overrides: Partial<CreateCampaignInput> = {}): CreateCampaignInput => ({
  guildId,
  organizerId: "u-org",
  name: "Moonlit Ruins",
  language: "en",
  adventureId: starterAdventureId,
  pacing: { preset: "live" },
  ...overrides,
});

function value<T>(result: ServiceResult<T>): T {
  if (result.kind === "refused") throw new Error(`Refused: ${result.reason}`);
  return result.value;
}

function refusal<T>(result: ServiceResult<T>): ServiceRefusal {
  if (result.kind === "ok") throw new Error("Expected a refusal.");
  return result.reason;
}

const heroIds = starter.en.heroes.map((hero) => hero.id);

async function fullLobby(): Promise<{ service: CampaignLobbyService; store: InMemoryCampaignStore; key: CampaignKey }> {
  const { service, store } = setup();
  const { key } = value(await service.create(input()));
  for (const [index, userId] of ["u-org", "u-b", "u-c"].entries()) {
    value(await service.join(key, userId));
    value(await service.chooseHero(key, userId, heroIds[index] ?? ""));
  }
  return { service, store, key };
}

describe("creating a campaign", () => {
  it("opens a lobby pinned to the adventure, with the pacing preset", async () => {
    const { service } = setup();
    const record = value(await service.create(input({ pacing: { preset: "playByPost" } })));
    expect(record).toMatchObject({
      lifecycle: "lobby",
      organizerId: "u-org",
      language: "en",
      adventure: { adventureId: starterAdventureId },
      pacingPreset: "playByPost",
      pacing: { roundSeconds: 86_400 },
      lobby: { status: "open", minPlayers: 1, maxPlayers: 3, members: [] },
      createdAt: 1_000,
    });
    expect((await service.get(record.key))?.record.name).toBe("Moonlit Ruins");
  });

  it("refuses bad names, unknown adventures, unsupported languages, and bad settings", async () => {
    const { service } = setup();
    expect(refusal(await service.create(input({ name: " x " })))).toBe("invalidName");
    expect(refusal(await service.create(input({ adventureId: "nope" })))).toBe("unknownAdventure");
    expect(refusal(await service.create(input({ pacing: { preset: "custom", pacing: { roundSeconds: 5, rollSeconds: null, turnSeconds: null, awayAfterMisses: 2 } } })))).toBe("invalidPacing");
    expect(refusal(await service.create(input({ houseRules: { "no-such-rule": "x" } })))).toBe("invalidHouseRules");
    expect(refusal(await service.create(input({ minPlayers: 3, maxPlayers: 2 })))).toBe("invalidLimits");
    expect(refusal(await service.create(input({ maxPlayers: 5 })))).toBe("invalidLimits");
  });

  it("keeps names unique among unfinished campaigns, ignoring case", async () => {
    const { service } = setup();
    const first = value(await service.create(input()));
    expect(refusal(await service.create(input({ name: "MOONLIT ruins" })))).toBe("nameTaken");
    expect((await service.create(input({ guildId: "g-2" }))).kind).toBe("ok");
    value(await service.cancel(first.key, "u-org"));
    expect((await service.create(input())).kind).toBe("ok");
  });
});

describe("the lobby", () => {
  it("seats players, lets them pick preset heroes, and lists them in order", async () => {
    const { service } = setup();
    const { key } = value(await service.create(input()));
    value(await service.join(key, "u-a"));
    value(await service.join(key, "u-b"));
    const chosen = value(await service.chooseHero(key, "u-b", heroIds[0] ?? ""));
    expect(chosen.lobby.members.map((member) => [member.userId, member.status])).toEqual([["u-a", "creating"], ["u-b", "ready"]]);
    expect(refusal(await service.chooseHero(key, "u-a", heroIds[0] ?? ""))).toBe("heroTaken");
    expect(refusal(await service.chooseHero(key, "u-a", "c-ghost"))).toBe("unknownHero");
  });

  it("gives the last seat to exactly one of two simultaneous joins", async () => {
    const { service } = setup();
    const { key } = value(await service.create(input({ maxPlayers: 2 })));
    value(await service.join(key, "u-a"));
    const results = await Promise.all([service.join(key, "u-b"), service.join(key, "u-c")]);
    expect(results.map((result) => result.kind).sort()).toEqual(["ok", "refused"]);
    const stored = await service.get(key);
    expect(stored?.record.lobby.members).toHaveLength(2);
  });

  it("stays consistent when many joins arrive at once", async () => {
    const { service } = setup();
    const { key } = value(await service.create(input()));
    await Promise.all(["u-1", "u-2", "u-3", "u-4", "u-5", "u-1", "u-2"].map((userId) => service.join(key, userId)));
    const members = (await service.get(key))?.record.lobby.members ?? [];
    expect(members.map((member) => member.userId)).toEqual(["u-1", "u-2", "u-3"]);
  });

  it("refuses changes for unknown campaigns and after the lobby closes", async () => {
    const { service } = setup();
    expect(refusal(await service.join({ guildId, campaignId: "missing" }, "u-a"))).toBe("notFound");
    const { key } = value(await service.create(input()));
    value(await service.cancel(key, "u-org"));
    expect(refusal(await service.join(key, "u-a"))).toBe("notLobby");
    expect((await service.get(key))?.record.lifecycle).toBe("archived");
  });

  it("does not let one server see another's campaigns", async () => {
    const { service } = setup();
    const { key } = value(await service.create(input()));
    expect(await service.get({ guildId: "g-2", campaignId: key.campaignId })).toBeUndefined();
    expect(await service.list("g-2")).toEqual([]);
  });
});

describe("starting the campaign", () => {
  it("creates the engine campaign from the seats and opens the first round", async () => {
    const { service, store, key } = await fullLobby();
    const started = value(await service.start(key, "u-org"));
    expect(started.record).toMatchObject({ lifecycle: "active", startedAt: 1_000 });
    expect(started.firstRound).toMatchObject({ kind: "accepted" });

    const stored = await store.transaction((tx) => tx.loadCampaign(key));
    expect(Object.keys(stored?.state.characters ?? {})).toEqual(heroIds);
    expect(stored?.state.members["u-b"]?.characterId).toBe(heroIds[1]);
    expect(stored?.state.organizerId).toBe("u-org");
    expect(stored?.state.round).toMatchObject({ number: 1, status: "collecting", participants: heroIds });
    expect(stored?.state.pacing).toMatchObject({ roundSeconds: 300 });
    expect(stored?.ruleset).toMatchObject({ houseRules: {} });
  });

  it("needs the organizer and a ready party, and only happens once", async () => {
    const { service, key } = await fullLobby();
    expect(refusal(await service.start(key, "u-b"))).toBe("notOrganizer");
    expect(value(await service.start(key, "u-org")).record.lifecycle).toBe("active");
    expect(refusal(await service.start(key, "u-org"))).toBe("notLobby");
  });

  it("refuses to start with someone still choosing a hero", async () => {
    const { service } = setup();
    const { key } = value(await service.create(input({ minPlayers: 2 })));
    value(await service.join(key, "u-org"));
    value(await service.chooseHero(key, "u-org", heroIds[0] ?? ""));
    expect(refusal(await service.start(key, "u-org"))).toBe("notEnoughPlayers");
    value(await service.join(key, "u-b"));
    expect(refusal(await service.start(key, "u-org"))).toBe("notReady");
  });

  it("plays the language edition the campaign was created in", async () => {
    const { service, store } = setup();
    const { key } = value(await service.create(input({ language: "zh-TW", name: "月光遺跡" })));
    value(await service.join(key, "u-org"));
    value(await service.chooseHero(key, "u-org", starter["zh-TW"].heroes[0]?.id ?? ""));
    value(await service.start(key, "u-org"));
    const stored = await store.transaction((tx) => tx.loadCampaign(key));
    expect(stored?.state.language).toBe("zh-TW");
    expect(Object.values(stored?.state.characters ?? {})[0]?.name).toBe(starter["zh-TW"].heroes[0]?.name);
  });
});
