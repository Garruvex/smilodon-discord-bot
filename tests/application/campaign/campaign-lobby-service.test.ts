import { describe, expect, it } from "vitest";

import type { AdventureDocument } from "../../../src/application/campaign/adventures/adventure-document.js";
import { UploadedAdventureLibrary } from "../../../src/application/campaign/adventures/uploaded-adventure-library.js";
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
    expect((await service.create(input({ maxPlayers: 5 }))).kind).toBe("ok");
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
  it("creates the engine campaign from the seats and asks for the opening before any round", async () => {
    const { service, store, key } = await fullLobby();
    const started = value(await service.start(key, "u-org"));
    expect(started.record).toMatchObject({ lifecycle: "active", startedAt: 1_000 });
    expect(started.firstRound).toMatchObject({ kind: "accepted" });

    const stored = await store.transaction((tx) => tx.loadCampaign(key));
    expect(Object.keys(stored?.state.characters ?? {})).toEqual(heroIds);
    expect(stored?.state.members["u-b"]?.characterId).toBe(heroIds[1]);
    expect(stored?.state.organizerId).toBe("u-org");
    // The Narrator's opening comes first; no round timer runs while the table reads it.
    expect(stored?.state.opening).toBe("pending");
    expect(stored?.state.round).toBeNull();
    expect((await store.transaction((tx) => tx.pendingOutbox("narrateOpening"))).map((item) => item.request.kind)).toEqual(["narrateOpening"]);
    expect(stored?.state.pacing).toMatchObject({ roundSeconds: 300 });
    expect(stored?.ruleset).toMatchObject({ houseRules: {} });
  });

  it("brings every hero up to the table's starting level", async () => {
    const { service, store } = setup();
    const { key } = value(await service.create(input({ houseRules: { "starting-level": "level3" } })));
    value(await service.join(key, "u-org"));
    value(await service.chooseHero(key, "u-org", heroIds[0] ?? ""));
    value(await service.start(key, "u-org"));
    const stored = await store.transaction((tx) => tx.loadCampaign(key));
    const levels = Object.values(stored?.state.characters ?? {}).map((sheet) => sheet.level);
    expect(levels.length).toBeGreaterThan(0);
    expect(levels.every((level) => level === 3)).toBe(true);
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

describe("joining an ongoing campaign", () => {
  async function running(visibility: "open" | "membersOnly" = "open"): Promise<{ service: ReturnType<typeof setup>["service"]; store: ReturnType<typeof setup>["store"]; key: CampaignKey }> {
    const { service, store } = setup();
    const { key } = value(await service.create(input({ visibility, maxPlayers: 3 })));
    value(await service.join(key, "u-org"));
    value(await service.chooseHero(key, "u-org", heroIds[0] ?? ""));
    value(await service.start(key, "u-org"));
    return { service, store, key };
  }

  it("lets a public applicant join only after approval, then records the story entrance", async () => {
    const { service, store, key } = await running();
    expect(refusal(await service.joinOngoingHero(key, "u-b", heroIds[1] ?? "", "before"))).toBe("joinNotApproved");
    value(await service.requestOngoingJoin(key, "u-b"));
    expect((await service.get(key))?.record.joinRequests?.["u-b"]?.status).toBe("requested");
    value(await service.decideOngoingJoin(key, "u-org", "u-b", true, "The party meets them at the inn."));
    value(await service.joinOngoingHero(key, "u-b", heroIds[1] ?? "", "joining"));
    const state = (await store.transaction((tx) => tx.loadCampaign(key)))?.state;
    expect(state?.members["u-b"]?.characterId).toBe(heroIds[1]);
    expect(state?.round?.participants ?? []).not.toContain(heroIds[1]);
    expect((await service.get(key))?.record.lobby.members).toHaveLength(2);
    expect((await service.get(key))?.record.joinRequests?.["u-b"]).toBeUndefined();
    expect((await store.transaction((tx) => tx.readEvents(key))).map((entry) => entry.event)).toContainEqual(expect.objectContaining({ kind: "heroJoined", entrance: "The party meets them at the inn." }));
    expect(await store.transaction((tx) => tx.pendingOutbox("deliver"))).toContainEqual(expect.objectContaining({ request: { kind: "deliver", delivery: { kind: "heroArrival", characterId: heroIds[1] } } }));
  });

  it("keeps private joining invitation-only and honors the seat limit", async () => {
    const { service, key } = await running("membersOnly");
    expect(refusal(await service.requestOngoingJoin(key, "u-b"))).toBe("privateInviteOnly");
    expect(refusal(await service.inviteOngoing(key, "u-b", "u-c", "They arrive."))).toBe("notOrganizer");
    value(await service.inviteOngoing(key, "u-org", "u-b", "They arrive."));
    expect((await service.get(key))?.record.joinRequests?.["u-b"]?.status).toBe("invited");
    value(await service.acceptOngoingInvite(key, "u-b"));
    expect((await service.get(key))?.record.joinRequests?.["u-b"]?.status).toBe("approved");
    value(await service.inviteOngoing(key, "u-org", "u-c", "They arrive later."));
    expect(refusal(await service.inviteOngoing(key, "u-org", "u-d", "They arrive later."))).toBe("gameFull");
  });
  it("shows a run-out invitation as expired and lets the player ask again, even in a private game", async () => {
    const { service, key, store } = await running("membersOnly");
    value(await service.inviteOngoing(key, "u-org", "u-b", "They arrive."));
    const stored = await store.transaction((tx) => tx.loadRecord(key));
    await store.transaction((tx) => tx.saveRecord({ ...stored!.record, joinRequests: { "u-b": { ...stored!.record.joinRequests!["u-b"]!, expiresAt: 0 } } }, stored!.revision));
    expect((await service.activityGames(guildId, "u-b")).find((game) => game.campaignId === key.campaignId)?.action).toBe("expired");
    value(await service.requestOngoingJoin(key, "u-b"));
    expect((await service.get(key))?.record.joinRequests?.["u-b"]?.status).toBe("requested");
  });
});

describe("an adventure that changes after the lobby opened", () => {
  const renamed = (document: AdventureDocument, version: string): AdventureDocument => ({
    ...document,
    bible: { ...document.bible, id: "uploaded-tale", version },
    heroes: document.heroes.map((hero) => ({ ...hero, id: `${hero.id}-v${version}` })),
  });

  function uploadedSetup(): { service: CampaignLobbyService; library: UploadedAdventureLibrary; store: InMemoryCampaignStore } {
    const store = new InMemoryCampaignStore();
    const content = ruleset().content;
    const clock = new ManualClock(1_000);
    const library = new UploadedAdventureLibrary(new StaticAdventureLibrary([{ id: starterAdventureId, editions: starter }]));
    library.add(guildId, renamed(starter.en, "1"));
    const service = new CampaignLobbyService({
      unitOfWork: store,
      bus: new CampaignCommandBus({ unitOfWork: store, rulesets: new RulesetCatalog([content]), clock }),
      adventures: library,
      clock,
      ruleset: { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} },
      newId: (): string => "camp-1",
    });
    return { service, library, store };
  }

  it("keeps the heroes and story of the version the lobby was opened with", async () => {
    const { service, library, store } = uploadedSetup();
    const { key } = value(await service.create(input({ adventureId: "uploaded-tale" })));
    library.add(guildId, renamed(starter.en, "2"));
    value(await service.join(key, "u-org"));

    const v1Hero = `${heroIds[0]}-v1`;
    expect(refusal(await service.chooseHero(key, "u-org", `${heroIds[0]}-v2`))).toBe("unknownHero");
    value(await service.chooseHero(key, "u-org", v1Hero));
    const started = value(await service.start(key, "u-org"));

    const stored = await store.transaction((tx) => tx.loadCampaign(key));
    expect(Object.keys(stored?.state.characters ?? {})).toEqual([v1Hero]);
    expect(started.record.adventure).toMatchObject({ adventureId: "uploaded-tale", version: "1" });
  });

  it("keeps one language's earlier edition available when a newer version has only another language", () => {
    const { library } = uploadedSetup();
    library.add(guildId, renamed(starter["zh-TW"], "1"));
    library.add(guildId, renamed(starter.en, "2"));
    expect(library.document("uploaded-tale", "zh-TW")?.bible.version).toBe("1");
    expect(library.document("uploaded-tale", "en")?.bible.version).toBe("2");
    expect([...(library.list().find((entry) => entry.id === "uploaded-tale")?.languages ?? [])].sort()).toEqual(["en", "zh-TW"]);
    expect(library.documentAt("uploaded-tale", "2", "zh-TW")).toBeUndefined();
  });
});

describe("changing the party size", () => {
  it("lets the organizer (or an admin) change it, and nobody else", async () => {
    const { service } = setup();
    const created = value(await service.create(input({ maxPlayers: 3 })));
    const key = created.key;
    expect(value(await service.setPartySize(key, "u-org", 5)).lobby.maxPlayers).toBe(5);
    expect(value(await service.setPartySize(key, null, 4)).lobby.maxPlayers).toBe(4);
    expect(await service.setPartySize(key, "u-other", 2)).toEqual({ kind: "refused", reason: "notOrganizer" });
    expect(await service.setPartySize(key, "u-org", 9)).toEqual({ kind: "refused", reason: "invalidLimits" });
  });
});

describe("opening the Activity from a channel that is not a game's", () => {
  it("goes straight into the one game the player is in, and lists when there are several or none", async () => {
    const { service } = setup();
    const first = value(await service.create(input({ name: "First" }))).key;
    value(await service.join(first, "u-a"));
    expect((await service.activityGameForChannel(guildId, "u-a", "hub"))?.campaignId).toBe(first.campaignId);
    expect(await service.activityGameForChannel(guildId, "u-stranger", "hub")).toBeNull();
    const second = value(await service.create(input({ name: "Second", organizerId: "u-other" }))).key;
    value(await service.join(second, "u-a"));
    expect(await service.activityGameForChannel(guildId, "u-a", "hub")).toBeNull();
  });
});
