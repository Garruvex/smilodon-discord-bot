import { describe, expect, it } from "vitest";

import { emptyChannels, type CampaignRecord } from "../../../src/application/campaign/ports/campaign-record.js";
import {
  buildHeroView,
  buildLobbyView,
  buildPanelView,
  buildPartyView,
} from "../../../src/application/campaign/views/campaign-views.js";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { chooseHero, join, openLobby, type LobbyResult, type LobbyState } from "../../../src/domain/campaign/lobby/lobby.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { loadStarterAdventure } from "../../../src/infrastructure/campaign/starter-adventures.js";
import { alex, jamie, livePacing, newCampaign, ruleset, run, system } from "../../domain/campaign/campaign-fixtures.js";
import { startedFight } from "../../domain/campaign/combat-fixtures.js";

const starter = loadStarterAdventure().en;
const content = ruleset().content;
const presets = starter.heroes.map((hero) => ({ id: hero.id, name: hero.name, className: hero.class }));

function lobbyOf(...steps: ((lobby: LobbyState) => LobbyResult)[]): LobbyState {
  const lobby = openLobby(2, 3);
  if (!lobby.ok) throw new Error("fixture");
  let state = lobby.lobby;
  for (const step of steps) {
    const next = step(state);
    if (!next.ok) throw new Error(`Refused: ${next.reason}`);
    state = next.lobby;
  }
  return state;
}

function record(lobby: LobbyState, overrides: Partial<CampaignRecord> = {}): CampaignRecord {
  return {
    key: { guildId: "g", campaignId: "c" },
    name: "Moonlit Ruins",
    organizerId: "u-alex",
    language: "en",
    lifecycle: "active",
    adventure: { adventureId: "moonlit-ruins", version: "1" },
    pacingPreset: "live",
    pacing: livePacing,
    houseRules: {},
    lobby,
    channels: emptyChannels,
    pendingResources: [],
    createdAt: 0,
    startedAt: 0,
    ...overrides,
  };
}

const inStory = (state: CampaignState): CampaignState => ({ ...state, sceneId: starter.bible.startScene });
const heroIds = presets.map((preset) => preset.id);

describe("the lobby view", () => {
  it("lists members with their chosen heroes and says what is missing to start", () => {
    const lobby = lobbyOf((l) => join(l, "u-a"), (l) => join(l, "u-b"), (l) => chooseHero(l, "u-a", heroIds[0] ?? "", heroIds));
    const view = buildLobbyView(record(lobby, { lifecycle: "lobby" }), starter.bible.title, presets);
    expect(view.members).toEqual([
      { userId: "u-a", status: "ready", heroName: presets[0]?.name, className: presets[0]?.className },
      { userId: "u-b", status: "creating", heroName: null, className: null },
    ]);
    expect(view).toMatchObject({ missing: "notReady", canJoin: true, open: true, minPlayers: 2, maxPlayers: 3 });
  });

  it("reports too few players, a full table, and a closed lobby", () => {
    const one = lobbyOf((l) => join(l, "u-a"), (l) => chooseHero(l, "u-a", heroIds[0] ?? "", heroIds));
    expect(buildLobbyView(record(one), "T", presets).missing).toBe("notEnoughPlayers");
    const full = lobbyOf((l) => join(l, "u-a"), (l) => join(l, "u-b"), (l) => join(l, "u-c"));
    expect(buildLobbyView(record(full), "T", presets).canJoin).toBe(false);
    const closed = { ...one, status: "started" as const };
    expect(buildLobbyView(record(closed), "T", presets)).toMatchObject({ open: false, canJoin: false });
  });
});

describe("hero views", () => {
  it("shows public stats, including armor class from gear, and away status", () => {
    const state = newCampaign();
    const away = { ...state, members: { ...state.members, "u-alex": { ...state.members["u-alex"]!, availability: "away" as const } } };
    const mira = buildHeroView(away, away.characters["c-mira"]!, content);
    expect(mira).toMatchObject({ name: "Mira", hp: 9, maxHp: 9, armorClass: 14, presence: "away", down: false, fallen: false, className: null });
    expect(buildPartyView(state, content).map((hero) => hero.name)).toEqual(["Mira", "Borin"]);
  });

  it("uses the fighter's HP and conditions in a fight, and marks fallen heroes", () => {
    const fight = startedFight();
    const hurt = {
      ...fight.state,
      encounter: {
        ...fight.encounter,
        combatants: { ...fight.encounter.combatants, "c-mira": { ...fight.encounter.combatants["c-mira"]!, hp: 0, conditions: ["condition:prone" as const] } },
      },
    };
    expect(buildHeroView(hurt, hurt.characters["c-mira"]!, content)).toMatchObject({ hp: 0, down: true, conditions: ["condition:prone"] });
    const dead = { ...fight.state, heroStatus: { "c-borin": { hp: 0, dead: true, resources: { spellSlots: {}, featureUses: {} } } } };
    expect(buildHeroView(dead, dead.characters["c-borin"]!, content).fallen).toBe(true);
  });
});

describe("the adventure panel view", () => {
  const open = (): CampaignState => inStory(run(newCampaign(livePacing), system, { kind: "openRound" }, { now: 0 }).state);

  it("shows who has submitted, passed, or is still thinking, with the deadline", () => {
    let state = open();
    state = run(state, alex, { kind: "submitAction", characterId: "c-mira", text: "I listen." }).state;
    const view = buildPanelView(record(lobbyOf()), state, starter.bible, enSrd51Glossary);
    expect(view).toMatchObject({ mode: "collecting", roundNumber: 1, closesAt: 300_000, sceneTitle: starter.bible.scenes[0]?.title });
    expect(view.roster.map((entry) => [entry.heroName, entry.status])).toEqual([["Mira", "submitted"], ["Borin", "thinking"]]);
    const passed = run(state, jamie, { kind: "pass", characterId: "c-borin" }).state;
    expect(buildPanelView(record(lobbyOf()), passed, starter.bible, enSrd51Glossary).mode).toBe("planning");
  });

  it("shows away heroes as away and waits explicitly when nobody is present", () => {
    let state = open();
    state = run(state, alex, { kind: "markAway", userId: "u-alex" }).state;
    expect(buildPanelView(record(lobbyOf()), state, starter.bible, enSrd51Glossary).roster.find((entry) => entry.heroName === "Mira")?.status).toBe("away");
    state = run(state, jamie, { kind: "markAway", userId: "u-jamie" }).state;
    const view = buildPanelView(record(lobbyOf()), state, starter.bible, enSrd51Glossary);
    expect(view.mode).toBe("waiting");
  });

  it("separates organizer pauses, restart pauses, and archived campaigns", () => {
    const paused = run(open(), { kind: "user", userId: "u-organizer" }, { kind: "pauseCampaign", reason: "organizer" }).state;
    expect(buildPanelView(record(lobbyOf()), paused, starter.bible, enSrd51Glossary).mode).toBe("paused");
    const recovering = run(open(), system, { kind: "pauseCampaign", reason: "recovery" }).state;
    expect(buildPanelView(record(lobbyOf()), recovering, starter.bible, enSrd51Glossary).mode).toBe("recovery");
    expect(buildPanelView(record(lobbyOf(), { lifecycle: "archived" }), open(), starter.bible, enSrd51Glossary).mode).toBe("archived");
  });

  it("lists pending rolls while checks wait", () => {
    let state = open();
    state = run(state, alex, { kind: "submitAction", characterId: "c-mira", text: "I sneak." }).state;
    state = run(state, jamie, { kind: "pass", characterId: "c-borin" }).state;
    state = run(state, system, {
      kind: "applyRoundPlan",
      proposal: {
        roundNumber: 1,
        actions: [{ characterId: "c-mira", resolution: { kind: "check", test: { kind: "skill", skill: "stealth" }, dcTier: "medium", rollModeReasons: [] } }],
      },
    }).state;
    const view = buildPanelView(record(lobbyOf()), state, starter.bible, enSrd51Glossary);
    expect(view.mode).toBe("awaitingRolls");
    expect(view.pendingRolls).toEqual([{ characterId: "c-mira", userId: "u-alex", heroName: "Mira" }]);
  });

  it("summarizes a fight with monster health bands and the active fighter", () => {
    const fight = startedFight(inStory(newCampaign(livePacing)));
    const view = buildPanelView(record(lobbyOf()), fight.state, starter.bible, enSrd51Glossary);
    expect(view.mode).toBe("combat");
    expect(view.combat).toMatchObject({ round: 1, activeName: "Mira" });
    expect(view.combat?.foes.map((foe) => foe.band)).toEqual(["unhurt", "unhurt"]);
    expect(view.combat?.party.map((hero) => hero.name)).toEqual(["Mira", "Borin"]);
  });
});
