import { describe, expect, it } from "vitest";

import { CampaignCommandBus } from "../../../src/application/campaign/campaign-command-bus.js";
import { assembleContext } from "../../../src/application/campaign/dm/context-assembler.js";
import { ScriptedNarrator, ScriptedPlanner } from "../../../src/application/campaign/dm/scripted-dm.js";
import { resolveStoryEffects } from "../../../src/application/campaign/dm/story-effects.js";
import type { CampaignKey } from "../../../src/application/campaign/ports/campaign-store.js";
import type { PlannerProposal } from "../../../src/application/campaign/ports/dm-ports.js";
import { RulesetCatalog } from "../../../src/application/campaign/rules/ruleset-catalog.js";
import { ManualClock } from "../../../src/application/campaign/time/manual-clock.js";
import { DmJobWorker } from "../../../src/application/campaign/workers/dm-job-worker.js";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import type { AdventureBible } from "../../../src/domain/campaign/adventure/adventure-bible.js";
import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { InMemoryCampaignStore } from "../../../src/infrastructure/persistence/campaign/in-memory-campaign-store.js";
import { alex, jamie, newCampaign, organizer, ruleset, system } from "../../domain/campaign/campaign-fixtures.js";
import { Fight, skirmish } from "../../domain/campaign/combat-fixtures.js";
import { secrets, testBible } from "./dm-fixtures.js";

const key: CampaignKey = { guildId: "g-1", campaignId: "camp-1" };
const tavern: CampaignState = { ...newCampaign(), sceneId: "scene:tavern" };

interface Table {
  readonly store: InMemoryCampaignStore;
  readonly bus: CampaignCommandBus;
  readonly worker: DmJobWorker;
  readonly log: () => Promise<readonly CampaignEvent[]>;
  readonly load: () => Promise<CampaignState>;
}

// A campaign whose state and event log are the given ones.
async function table(
  planner: ScriptedPlanner,
  narrator: ScriptedNarrator,
  state: CampaignState = tavern,
  history: readonly CampaignEvent[] = [],
): Promise<Table> {
  const store = new InMemoryCampaignStore();
  const clock = new ManualClock(0);
  const content = ruleset().content;
  const bus = new CampaignCommandBus({ unitOfWork: store, rulesets: new RulesetCatalog([content]), clock });
  await store.transaction((tx) =>
    tx.createCampaign(key, {
      state,
      revision: 0,
      ruleset: { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} },
      adventure: { adventureId: testBible.id, version: testBible.version },
    }),
  );
  const envelope = { campaignId: key.campaignId, causationId: "setup", commandKind: "startEncounter", actor: system, rulesRevision: "setup", recordedAt: 0 } as const;
  await store.transaction((tx) => tx.appendEvents(key, history.map((event) => ({ ...envelope, event }))));
  const worker = new DmJobWorker({
    unitOfWork: store,
    bus,
    planner,
    narrator,
    adventures: { find: (): AdventureBible => testBible },
    glossaries: { en: enSrd51Glossary },
    maxAttempts: 2,
  });
  const log = async (): Promise<readonly CampaignEvent[]> => (await store.transaction((tx) => tx.readEvents(key))).map((envelope) => envelope.event);
  const load = async (): Promise<CampaignState> => {
    const stored = await store.transaction((tx) => tx.loadCampaign(key));
    if (stored === undefined) throw new Error("missing campaign");
    return stored.state;
  };
  return { store, bus, worker, log, load };
}

// The fight skirmish (Mira 20, Borin 15, goblins 5 and 4) in round 2, every
// goblin attack having missed; a flourish for round 1 is due.
function roundTwo(): Fight {
  const fight = new Fight().rolls([20, 15, 5, 4]).run(organizer, { kind: "startEncounter", spec: skirmish });
  return fight.run(alex, { kind: "endTurn", combatantId: "c-mira" }).rolls([2, 2]).run(jamie, { kind: "endTurn", combatantId: "c-borin" });
}

const trapdoorFight: PlannerProposal = {
  roundNumber: 1,
  actions: [{ characterId: "c-mira", resolution: { kind: "automatic", reason: "The trapdoor is not locked." } }],
  effects: [{ kind: "startEncounter", encounterId: "encounter:cellar-goblins", when: { kind: "always" } }],
};

describe("story effects from the Planner", () => {
  it("resolves authored IDs to definitions and refuses ones the party cannot reach", () => {
    const resolved = resolveStoryEffects(trapdoorFight, testBible, tavern);
    expect(resolved).toMatchObject({
      kind: "resolved",
      proposal: { effects: [{ effect: { kind: "startEncounter", encounter: { id: "encounter:cellar-goblins", partyZoneId: "bar" } } }] },
    });

    const wrong: PlannerProposal = {
      ...trapdoorFight,
      effects: [
        { kind: "transitionScene", sceneId: "scene:moon", when: { kind: "always" } },
        { kind: "transitionScene", sceneId: "scene:tavern", when: { kind: "always" } },
        { kind: "startEncounter", encounterId: "encounter:dragon", when: { kind: "always" } },
      ],
    };
    expect(resolveStoryEffects(wrong, testBible, tavern)).toEqual({
      kind: "invalid",
      problems: ['Unknown scene "scene:moon".', "The party is already in scene:tavern; drop the transition.", 'Unknown encounter "encounter:dragon".'],
    });
    expect(resolveStoryEffects(trapdoorFight, testBible, { ...tavern, sceneId: null })).toMatchObject({
      problems: ["encounter:cellar-goblins belongs to scene:tavern, where the party is not."],
    });
    expect(resolveStoryEffects(trapdoorFight, testBible, { ...tavern, encounterHistory: ["encounter:cellar-goblins"] })).toMatchObject({
      problems: ["encounter:cellar-goblins has already been fought."],
    });
  });

  it("starts the authored fight after narration that leads into it", async () => {
    const planner = new ScriptedPlanner([trapdoorFight]);
    const narrator = new ScriptedNarrator([{ text: "The trapdoor bangs open." }]);
    const { bus, worker, log, load } = await table(planner, narrator);
    await bus.execute(key, { kind: "openRound" }, { commandId: "1", actor: system });
    await bus.execute(key, { kind: "submitAction", characterId: "c-mira", text: "I open the trapdoor." }, { commandId: "2", actor: alex });
    await bus.execute(key, { kind: "pass", characterId: "c-borin" }, { commandId: "3", actor: jamie });

    await worker.runOnce(); // plan
    expect(planner.requests[0]?.story).toEqual({
      sceneId: "scene:tavern",
      sceneIds: ["scene:tavern"],
      encounters: [{ id: "encounter:cellar-goblins", sceneId: "scene:tavern" }],
      clocks: [{ id: "clock:guards-return", sceneId: "scene:tavern", filled: 0, segments: 3 }],
      clues: [{ id: "clue:cellar-key", sceneId: "scene:tavern" }],
    });
    await worker.runOnce(); // narrate
    expect(narrator.requests[0]?.threat).toBe("Goblins burst up through the cellar trapdoor.");
    expect(JSON.stringify(narrator.requests[0])).not.toContain(secrets.encounter);

    expect((await log()).map((event) => event.kind).slice(-2)).toEqual(["narrationRecorded", "encounterStarted"]);
    const state = await load();
    expect(state.encounter?.id).toBe("encounter:cellar-goblins");
    expect(state.encounterHistory).toEqual(["encounter:cellar-goblins"]);
  });
});

describe("clocks and clues from the Planner", () => {
  const ticking: PlannerProposal = {
    ...trapdoorFight,
    effects: [
      { kind: "advanceClock", clockId: "clock:guards-return", by: 2, when: { kind: "always" } },
      { kind: "revealClue", clueId: "clue:cellar-key", when: { kind: "checkOutcome", characterId: "c-mira", success: true } },
    ],
  };

  it("resolves a clock with its size and the fight it starts, and a clue with its public text", () => {
    expect(resolveStoryEffects(ticking, testBible, tavern)).toMatchObject({
      kind: "resolved",
      proposal: {
        effects: [
          { effect: { kind: "advanceClock", clockId: "clock:guards-return", segments: 3, by: 2, onFull: { id: "encounter:cellar-goblins" } } },
          { effect: { kind: "revealClue", clueId: "clue:cellar-key", text: "A brass key hangs behind the bar." } },
        ],
      },
    });
    const fought = { ...tavern, encounterHistory: ["encounter:cellar-goblins"] };
    expect(resolveStoryEffects(ticking, testBible, fought)).toMatchObject({
      proposal: { effects: [{ effect: { kind: "advanceClock", onFull: null } }, { effect: { kind: "revealClue" } }] },
    });
  });

  it("refuses unknown, out-of-place, or repeated clocks and clues, and absurd advances", () => {
    const bad: PlannerProposal = {
      ...trapdoorFight,
      effects: [
        { kind: "advanceClock", clockId: "clock:nope", by: 1, when: { kind: "always" } },
        { kind: "advanceClock", clockId: "clock:guards-return", by: 9, when: { kind: "always" } },
        { kind: "revealClue", clueId: "clue:nope", when: { kind: "always" } },
        { kind: "revealClue", clueId: "clue:cellar-key", when: { kind: "always" } },
      ],
    };
    const known = { ...tavern, clues: [{ id: "clue:cellar-key", text: "A brass key hangs behind the bar." }] };
    expect(resolveStoryEffects(bad, testBible, known)).toEqual({
      kind: "invalid",
      problems: [
        'Unknown clock "clock:nope".',
        "clock:guards-return may advance by 1 to 3 segments.",
        'Unknown clue "clue:nope".',
        "clue:cellar-key was already revealed.",
      ],
    });
    expect(resolveStoryEffects(ticking, testBible, { ...tavern, sceneId: null })).toMatchObject({
      problems: ["clock:guards-return belongs to scene:tavern, where the party is not.", "clue:cellar-key belongs to scene:tavern, where the party is not."],
    });
  });

  it("shows the Planner the clock and clue notes, and the Narrator only what was revealed", () => {
    const state = {
      ...tavern,
      clocks: { "clock:guards-return": { segments: 3, filled: 2 } },
      clues: [{ id: "clue:cellar-key", text: "A brass key hangs behind the bar." }],
    };
    const base = { state, events: [], bible: testBible, glossary: enSrd51Glossary, budgetTokens: 30_000 };
    const text = (audience: "planner" | "narrator"): string =>
      assembleContext({ ...base, audience }).sections.map((section) => section.text).join("\n");
    expect(text("planner")).toContain(secrets.clock);
    expect(text("planner")).toContain(secrets.clue);
    expect(text("planner")).toContain("Clock clock:guards-return: 2/3.");
    expect(text("narrator")).not.toContain(secrets.clock);
    expect(text("narrator")).not.toContain(secrets.clue);
    expect(text("narrator")).not.toContain("clock:guards-return");
    expect(text("narrator")).toContain("Revealed clues: A brass key hangs behind the bar.");
  });
});

describe("combat narration jobs", () => {
  it("narrates a finished combat round from its public beats", async () => {
    const fight = roundTwo();
    const narrator = new ScriptedNarrator([], [{ text: "Arrows hiss past Mira." }]);
    const { store, worker, log } = await table(new ScriptedPlanner([]), narrator, fight.state, fight.events);
    await store.transaction((tx) => tx.enqueue(key, "flourish-1", { kind: "narrateCombat", encounterId: "enc-1", round: 1, final: false }, 0));

    expect(await worker.runOnce()).toEqual({ processed: 1, failed: [] });
    const request = narrator.combatRequests[0];
    expect(request).toMatchObject({ encounterId: "enc-1", round: 1, final: false, outcome: null });
    // Both goblins shot at someone and missed.
    expect(request?.beats.filter((beat) => beat.kind === "action")).toHaveLength(2);
    expect(request?.beats[0]).toMatchObject({ kind: "action", actor: "Goblin A", using: "Shortbow", targets: [{ check: "miss", hpChange: 0 }] });
    expect((await log()).at(-1)).toEqual({ kind: "combatNarrationRecorded", round: 1, text: "Arrows hiss past Mira.", final: false });
  });

  it("skips a flourish the Narrator fails on; play never waits for it", async () => {
    const fight = roundTwo();
    const { store, worker, log } = await table(new ScriptedPlanner([]), new ScriptedNarrator([], [new Error("timeout")]), fight.state, fight.events);
    await store.transaction((tx) => tx.enqueue(key, "flourish-1", { kind: "narrateCombat", encounterId: "enc-1", round: 1, final: false }, 0));
    expect(await worker.runOnce()).toEqual({ processed: 1, failed: [] });
    expect((await log()).some((event) => event.kind === "combatNarrationRecorded")).toBe(false);
  });

  it("falls back to a template closing line so exploration resumes", async () => {
    const fight = roundTwo();
    const encounter = fight.encounter;
    fight.state = {
      ...fight.state,
      encounter: {
        ...encounter,
        combatants: Object.fromEntries(
          Object.entries(encounter.combatants).map(([id, combatant]) => [id, combatant.side === "foes" ? { ...combatant, hp: 1, fleeBelowHpFraction: 0.99 } : combatant]),
        ),
      },
    };
    fight.run(alex, { kind: "endTurn", combatantId: "c-mira" }).run(jamie, { kind: "endTurn", combatantId: "c-borin" });
    expect(fight.encounter.outcome).toBe("victory");

    const narrator = new ScriptedNarrator([], [new Error("down"), new Error("down")]);
    const { store, worker, log } = await table(new ScriptedPlanner([]), narrator, fight.state, fight.events);
    await store.transaction((tx) => tx.enqueue(key, "closing", { kind: "narrateCombat", encounterId: "enc-1", round: 2, final: true }, 0));
    expect((await worker.runOnce()).failed).toHaveLength(1);
    await worker.runOnce();
    // Round 1 was never narrated, so the closing covers it too: two misses, then the goblins flee.
    expect(narrator.combatRequests[0]?.beats.map((beat) => beat.kind)).toEqual(["action", "action", "fled", "fled"]);
    const tail = (await log()).slice(-2);
    expect(tail[0]).toEqual({ kind: "combatNarrationRecorded", round: 2, text: "The fight is over; the enemy is beaten.", final: true });
    expect(tail[1]).toMatchObject({ kind: "roundOpened" });
  });
});

describe("combat in the DM context", () => {
  it("shows the Planner authored fights with their notes, and everyone the fight as it stands", () => {
    const fight = roundTwo();
    const events = [...fight.events];
    const base = { state: fight.state, events, bible: testBible, glossary: enSrd51Glossary, budgetTokens: 30_000 };
    const planner = assembleContext({ ...base, audience: "planner" }).sections.map((section) => section.text).join("\n");
    expect(planner).toContain(`encounter:cellar-goblins in scene:tavern: Goblins burst up through the cellar trapdoor.\nFoes: Goblin\nDM notes: ${secrets.encounter}`);

    const narrator = assembleContext({ ...base, audience: "narrator" }).sections.map((section) => section.text).join("\n");
    expect(narrator).not.toContain(secrets.encounter);
    expect(narrator).toContain("In combat, round 2. Foes: Goblin A (unhurt), Goblin B (unhurt).");
    expect(narrator).toContain("Mira: present, HP 9/9");
  });
});
