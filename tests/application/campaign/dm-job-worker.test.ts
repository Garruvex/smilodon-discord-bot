import { describe, expect, it } from "vitest";

import { CampaignCommandBus } from "../../../src/application/campaign/campaign-command-bus.js";
import {
  ContextBudgetError,
  assembleContext,
  estimateTokens,
  type ContextInput,
} from "../../../src/application/campaign/dm/context-assembler.js";
import { ScriptedNarrator, ScriptedPlanner } from "../../../src/application/campaign/dm/scripted-dm.js";
import type { CampaignKey } from "../../../src/application/campaign/ports/campaign-store.js";
import { SeededRandomSource } from "../../../src/application/campaign/random/seeded-random-source.js";
import { RulesetCatalog } from "../../../src/application/campaign/rules/ruleset-catalog.js";
import { ManualClock } from "../../../src/application/campaign/time/manual-clock.js";
import { DmJobWorker } from "../../../src/application/campaign/workers/dm-job-worker.js";
import { RollWorker } from "../../../src/application/campaign/workers/roll-worker.js";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import type { AdventureBible } from "../../../src/domain/campaign/adventure/adventure-bible.js";
import type { ScriptedProposal } from "../../../src/application/campaign/dm/scripted-dm.js";
import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import type { CharacterSheet } from "../../../src/domain/campaign/character/character-sheet.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { InMemoryCampaignStore } from "../../../src/infrastructure/persistence/campaign/in-memory-campaign-store.js";
import { alex, d20Roll, jamie, newCampaign, organizer, ruleset, run, system } from "../../domain/campaign/campaign-fixtures.js";
import { secrets, testBible } from "./dm-fixtures.js";

const key: CampaignKey = { guildId: "g-1", campaignId: "camp-1" };

const sneak: ScriptedProposal = {
  roundNumber: 1,
  actions: [
    {
      characterId: "c-mira",
      resolution: { kind: "check", test: { kind: "skill", skill: "stealth" }, dcTier: "medium", rollModeReasons: [] },
    },
  ],
};

const offLadder = {
  roundNumber: 1,
  actions: [
    {
      characterId: "c-mira",
      resolution: { kind: "check", test: { kind: "skill", skill: "stealth" }, dcTier: "tricky", rollModeReasons: [] },
    },
  ],
} as unknown as ScriptedProposal;

function startState(): CampaignState {
  const ledger = {
    "npc:garrick": {
      entityId: "npc:garrick",
      canonicalName: "Garrick",
      facts: [
        { text: "Greeted the party warmly.", visibility: "public" as const },
        { text: "SECRET-LEDGER-reported-the-party", visibility: "secret" as const },
      ],
    },
  };
  return { ...newCampaign(), sceneId: "scene:tavern", ledger };
}

interface Table {
  readonly store: InMemoryCampaignStore;
  readonly bus: CampaignCommandBus;
  readonly worker: DmJobWorker;
  readonly rolls: RollWorker;
  readonly planner: ScriptedPlanner;
  readonly narrator: ScriptedNarrator;
}

async function table(planner: ScriptedPlanner, narrator: ScriptedNarrator, state = startState()): Promise<Table> {
  const store = new InMemoryCampaignStore();
  const clock = new ManualClock(0);
  const content = ruleset().content;
  const bus = new CampaignCommandBus({ unitOfWork: store, rulesets: new RulesetCatalog([content]), clock });
  await store.transaction((tx) =>
    tx.createCampaign(key, {
      state,
      revision: 0,
      ruleset: { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} },
      adventure: { adventureId: "test-adventure", version: "1" },
    }),
  );
  const worker = new DmJobWorker({
    unitOfWork: store,
    bus,
    planner,
    narrator,
    adventures: { find: (id, version): AdventureBible | undefined => (id === testBible.id && version === testBible.version ? testBible : undefined) },
    glossaries: { en: enSrd51Glossary, "zh-TW": zhTwSrd51Glossary },
    maxAttempts: 2,
  });
  const rolls = new RollWorker(store, bus, new SeededRandomSource(4), clock);
  return { store, bus, worker, rolls, planner, narrator };
}

let commandNumber = 0;
async function closeRoundOne(bus: CampaignCommandBus): Promise<void> {
  const id = (): string => `c-${++commandNumber}`;
  await bus.execute(key, { kind: "openRound" }, { commandId: id(), actor: system });
  await bus.execute(key, { kind: "submitAction", characterId: "c-mira", text: "I sneak past Garrick." }, { commandId: id(), actor: alex });
  await bus.execute(key, { kind: "pass", characterId: "c-borin" }, { commandId: id(), actor: jamie });
}

async function events(store: InMemoryCampaignStore): Promise<readonly CampaignEvent[]> {
  return (await store.transaction((tx) => tx.readEvents(key))).map((envelope) => envelope.event);
}

function contextInput(overrides: Partial<ContextInput> = {}): ContextInput {
  const state = startState();
  let played = run(state, system, { kind: "openRound" });
  const all: CampaignEvent[] = [...played.events];
  played = run(played.state, alex, { kind: "submitAction", characterId: "c-mira", text: "I sneak past Garrick." });
  all.push(...played.events);
  played = run(played.state, jamie, { kind: "pass", characterId: "c-borin" });
  all.push(...played.events);
  played = run(played.state, system, {
    kind: "applyRoundPlan",
    proposal: { roundNumber: 1, actions: [{ characterId: "c-mira", resolution: { kind: "automatic", reason: "PLANNER-REASON-he-is-asleep" } }] },
  });
  all.push(...played.events);
  return {
    audience: "narrator",
    state: played.state,
    events: all,
    bible: testBible,
    glossary: enSrd51Glossary,
    budgetTokens: 30_000,
    ...overrides,
  };
}

function textOf(context: ReturnType<typeof assembleContext>): string {
  return context.sections.map((section) => section.text).join("\n");
}

describe("assembleContext", () => {
  it("gives the Planner the whole bible, including secrets", () => {
    const text = textOf(assembleContext(contextInput({ audience: "planner" })));
    for (const secret of [...Object.values(secrets), "SECRET-LEDGER-reported-the-party", "PLANNER-REASON-he-is-asleep"]) {
      expect(text).toContain(secret);
    }
  });

  it("gives the Narrator a public-only projection", () => {
    const context = assembleContext(contextInput());
    const text = textOf(context);
    expect(text).not.toMatch(/SECRET-|PLANNER-REASON/);
    expect(text).toContain("A smoky tavern full of nervous travelers.");
    expect(text).toContain("Greeted the party warmly.");
    expect(text).toContain('Mira: "I sneak past Garrick." -> succeeds without a roll');
    expect(context.sections.map((section) => section.layer)).toEqual(["A", "B", "C", "E", "F"]);
  });

  it("tells both the Planner and the Narrator what heroes said in character, capped per hero", () => {
    const input = contextInput();
    const said: CampaignEvent[] = ["one", "two", "three", "four"].map((text) => ({ kind: "heroSpoke" as const, characterId: "c-mira", roundNumber: 1, text: `line ${text}` }));
    for (const audience of ["planner", "narrator"] as const) {
      const text = textOf(assembleContext({ ...input, audience, events: [...input.events, ...said] }));
      // Words, not actions: marked as such, and only the latest three per hero.
      expect(text).toContain('- Mira said in character (not an action): "line two" "line three" "line four"');
      expect(text).not.toContain("line one");
    }
  });

  it("asks for Traditional Chinese for a zh-TW campaign and lists the glossary", () => {
    const input = contextInput({ glossary: zhTwSrd51Glossary });
    const text = textOf(assembleContext({ ...input, state: { ...input.state, language: "zh-TW" } }));
    expect(text).toContain("Traditional Chinese with Taiwan usage");
    expect(text).toContain("condition:prone = 倒地");
  });

  it("drops the oldest rounds to fit the budget, keeping the latest, and fails when even that cannot fit", () => {
    const input = contextInput();
    const extra: CampaignEvent[] = Array.from({ length: 40 }, (_, index) => ({
      kind: "narrationRecorded" as const,
      roundNumber: index + 2,
      // Repeated generously so the fixed overhead (instructions, glossary)
      // stays a small fraction of the total regardless of glossary size,
      // keeping "half of full" a reliably sufficient tight budget below.
      text: "The wind howls through the ruins. ".repeat(60),
    }));
    const full = assembleContext({ ...input, events: [...input.events, ...extra] });
    const tight = assembleContext({ ...input, events: [...input.events, ...extra], budgetTokens: Math.floor(full.estimatedTokens / 2) });
    expect(tight.omittedRounds).toBeGreaterThan(0);
    expect(tight.estimatedTokens).toBeLessThanOrEqual(Math.floor(full.estimatedTokens / 2));
    expect(tight.sections.find((section) => section.layer === "D")?.text).toContain("earlier round(s) are not shown");
    expect(textOf(tight)).toContain("Round 41");
    expect(() => assembleContext({ ...input, budgetTokens: 50 })).toThrow(ContextBudgetError);
  });

  it("counts CJK characters as about one token each", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("倒地倒地")).toBe(4);
  });
});

describe("DmJobWorker", () => {
  it("plans, rolls, narrates, and opens the next round, with secrets kept out of narration", async () => {
    const planner = new ScriptedPlanner([sneak]);
    const narrator = new ScriptedNarrator([{ text: "Mira melts into the shadows." }]);
    const { store, bus, worker, rolls } = await table(planner, narrator);
    await closeRoundOne(bus);

    expect(await worker.runOnce()).toEqual({ processed: 1, failed: [] });
    expect(planner.requests[0]?.actions).toEqual([{ characterId: "c-mira", heroName: "Mira", text: "I sneak past Garrick." }]);
    expect(planner.requests[0]?.vocabulary.dcTiers).toContain("medium");

    await bus.execute(key, { kind: "requestRoll", checkId: "r1:c-mira" }, { commandId: "roll-click", actor: alex });
    await rolls.runOnce();
    expect(await worker.runOnce()).toEqual({ processed: 1, failed: [] });

    const request = narrator.requests[0];
    expect(request?.outcomes).toHaveLength(1);
    expect(request?.outcomes[0]).toMatchObject({ heroName: "Mira", action: "I sneak past Garrick.", result: { kind: "check", check: "stealth", dc: 15 } });
    expect(request?.spotlight).toEqual(["Borin"]);
    expect(JSON.stringify(request)).not.toContain("SECRET-");

    const log = await events(store);
    expect(log).toContainEqual({ kind: "narrationRecorded", roundNumber: 1, text: "Mira melts into the shadows." });
    expect(log.at(-1)).toMatchObject({ kind: "roundOpened", roundNumber: 2 });
  });

  it("retries an invalid plan once with the engine's problems", async () => {
    const planner = new ScriptedPlanner([offLadder, sneak]);
    const { store, bus, worker } = await table(planner, new ScriptedNarrator([]));
    await closeRoundOne(bus);
    await worker.runOnce();
    expect(planner.requests[1]?.previousProblems).toEqual(['c-mira: DC tier "tricky" is not on the ladder.']);
    const stored = await store.transaction((tx) => tx.loadCampaign(key));
    expect(stored?.state.round?.status).toBe("resolving");
  });

  it("tries a failed plan again later, then plans the round without the model so play is never held", async () => {
    const planner = new ScriptedPlanner([offLadder, new Error("provider timeout"), offLadder, new Error("provider timeout")]);
    const { store, bus, worker } = await table(planner, new ScriptedNarrator([]));
    await closeRoundOne(bus);
    // The first try fails and the job is queued again; the round is not planned yet.
    expect(await worker.runOnce()).toMatchObject({ processed: 0, failed: [{ id: expect.any(String) as string, error: "The planner failed: The planner call failed: provider timeout" }] });
    expect((await events(store)).some((event) => event.kind === "roundPlanApplied")).toBe(false);
    expect(await worker.runOnce()).toEqual({ processed: 1, failed: [] });

    // Only the last try falls back: a plain plan with no story effect, so the organizer is not asked to step in.
    const log = await events(store);
    expect(log.some((event) => event.kind === "roundPlanApplied")).toBe(true);
    expect(log.some((event) => event.kind === "plannerFailed")).toBe(false);
  });

  it("plans the round without the model when it keeps proposing invalid plans", async () => {
    const planner = new ScriptedPlanner([offLadder, offLadder, offLadder, offLadder]);
    const { store, bus, worker } = await table(planner, new ScriptedNarrator([]));
    await closeRoundOne(bus);
    await worker.runOnce();
    await worker.runOnce();
    const log = await events(store);
    expect(log.some((event) => event.kind === "roundPlanApplied")).toBe(true);
    expect(log.some((event) => event.kind === "plannerFailed")).toBe(false);
  });

  it("falls back to template narration when the Narrator keeps failing, so play continues", async () => {
    const planner = new ScriptedPlanner([
      { roundNumber: 1, actions: [{ characterId: "c-mira", resolution: { kind: "automatic", reason: "No one is looking." } }] },
    ]);
    const narrator = new ScriptedNarrator([new Error("rate limited"), new Error("rate limited")]);
    const { store, bus, worker } = await table(planner, narrator);
    await closeRoundOne(bus);
    await worker.runOnce(); // plan

    expect(await worker.runOnce()).toMatchObject({ processed: 0, failed: [{ error: "rate limited" }] });
    expect(await worker.runOnce()).toEqual({ processed: 1, failed: [] });
    const log = await events(store);
    expect(log).toContainEqual({ kind: "narrationRecorded", roundNumber: 1, text: "Mira: I sneak past Garrick." });
    expect(log.at(-1)).toMatchObject({ kind: "roundOpened", roundNumber: 2 });
  });
});

describe("narrateTrade", () => {
  async function tableWithATrade(narrator: ScriptedNarrator): Promise<Table> {
    const table_ = await table(new ScriptedPlanner([]), narrator, { ...startState(), gold: 100 });
    await table_.bus.execute(key, { kind: "buyItem", characterId: "c-mira", npcId: "npc:garrick", itemId: "item:dagger", price: 20 }, { commandId: "buy-1", actor: alex });
    return table_;
  }

  it("resolves the NPC's name and voice from the bible, and the item's name from the glossary", async () => {
    const narrator = new ScriptedNarrator([], [], [{ text: "Garrick grunts and slides the dagger across the bar." }]);
    const { store, worker } = await tableWithATrade(narrator);
    expect(await worker.runOnce()).toEqual({ processed: 1, failed: [] });

    expect(narrator.tradeRequests[0]).toMatchObject({
      npc: { id: "npc:garrick", name: "Garrick", voice: "Gruff, clipped sentences." },
      heroName: "Mira",
      itemName: "Dagger",
      direction: "buy",
      completed: true,
      listedPrice: 20,
      finalPrice: 20,
      haggle: null,
    });
    const log = await events(store);
    expect(log).toContainEqual({ kind: "tradeNarrated", tradeId: "trade:1", text: "Garrick grunts and slides the dagger across the bar." });
  });

  it("falls back to a template line once the Narrator's attempts are spent", async () => {
    const narrator = new ScriptedNarrator([], [], [new Error("rate limited"), new Error("rate limited")]);
    const { store, worker } = await tableWithATrade(narrator);
    expect(await worker.runOnce()).toMatchObject({ processed: 0, failed: [{ error: "rate limited" }] });
    expect(await worker.runOnce()).toEqual({ processed: 1, failed: [] });
    const log = await events(store);
    expect(log).toContainEqual({ kind: "tradeNarrated", tradeId: "trade:1", text: "Garrick sells to Mira the Dagger for 20 gold." });
  });
});

describe("narrateDialogue", () => {
  async function tableWithADialogue(narrator: ScriptedNarrator): Promise<Table> {
    const table_ = await table(new ScriptedPlanner([]), narrator);
    await table_.bus.execute(
      key,
      { kind: "askNpc", characterId: "c-mira", npcId: "npc:garrick", question: "Any news from the road?" },
      { commandId: "ask-1", actor: alex },
    );
    return table_;
  }

  it("resolves the NPC's name, voice, and public description from the bible, without ever seeing the secret", async () => {
    const narrator = new ScriptedNarrator([], [], [], [{ text: 'Garrick grunts: "Nothing worth telling."' }]);
    const { store, worker } = await tableWithADialogue(narrator);
    expect(await worker.runOnce()).toEqual({ processed: 1, failed: [] });

    expect(narrator.dialogueRequests[0]).toMatchObject({
      npc: { id: "npc:garrick", name: "Garrick", voice: "Gruff, clipped sentences.", publicDescription: "The tavern keeper, polishing the same mug.", secret: null },
      heroName: "Mira",
      kind: "ask",
      question: "Any news from the road?",
      press: null,
      secretRevealed: false,
    });
    const log = await events(store);
    expect(log).toContainEqual({ kind: "dialogueNarrated", dialogueId: "dialogue:1", text: 'Garrick grunts: "Nothing worth telling."' });
  });

  it("answers two heroes at the same NPC in submission order with the first reply in the second context", async () => {
    const narrator = new ScriptedNarrator([], [], [], [{ text: "First answer." }, { text: "Second answer." }]);
    const { bus, worker, store } = await table(new ScriptedPlanner([]), narrator);
    expect((await bus.execute(key, { kind: "askNpc", characterId: "c-mira", npcId: "npc:garrick", question: "First question?" }, { commandId: "talk-mira", actor: alex })).kind).toBe("accepted");
    expect((await bus.execute(key, { kind: "askNpc", characterId: "c-borin", npcId: "npc:garrick", question: "Second question?" }, { commandId: "talk-borin", actor: jamie })).kind).toBe("accepted");
    await worker.runOnce();
    await worker.runOnce();
    expect(narrator.dialogueRequests.map((request) => request.question)).toEqual(["First question?", "Second question?"]);
    expect(narrator.dialogueRequests[1]?.context.sections.some((section) => section.text.includes("First answer."))).toBe(true);
    const told = (await events(store)).filter((event) => event.kind === "dialogueNarrated");
    expect(told.map((event) => event.dialogueId)).toEqual(["dialogue:1", "dialogue:2"]);
  });

  it("falls back to a template line once the Narrator's attempts are spent", async () => {
    const narrator = new ScriptedNarrator([], [], [], [new Error("rate limited"), new Error("rate limited")]);
    const { store, worker } = await tableWithADialogue(narrator);
    expect(await worker.runOnce()).toMatchObject({ processed: 0, failed: [{ error: "rate limited" }] });
    expect(await worker.runOnce()).toEqual({ processed: 1, failed: [] });
    const log = await events(store);
    expect(log).toContainEqual({ kind: "dialogueNarrated", dialogueId: "dialogue:1", text: "Garrick answers your question." });
  });
});

const rowan: CharacterSheet = {
  id: "c-rowan",
  ownerUserId: "u-alex",
  name: "Rowan",
  abilityScores: { str: 8, dex: 12, con: 14, int: 16, wis: 13, cha: 10 },
  proficiencyBonus: 2,
  skills: { arcana: "proficient" },
  savingThrows: ["int", "wis"],
  level: 1,
  maxHp: 7,
  hitDie: 6,
  speed: 30,
  equipment: ["item:dagger"],
  features: ["feature:arcane-recovery"],
  spellcasting: { ability: "int", spells: ["spell:mage-hand", "spell:detect-magic"], slots: { 1: 2 } },
};

describe("narrateUtilityCast", () => {
  async function tableWithAUtilityCast(narrator: ScriptedNarrator): Promise<Table> {
    const state = { ...startState(), characters: { ...startState().characters, "c-rowan": rowan } };
    const table_ = await table(new ScriptedPlanner([]), narrator, state);
    await table_.bus.execute(key, { kind: "castRitualSpell", characterId: "c-rowan", spellId: "spell:detect-magic" }, { commandId: "cast-1", actor: alex });
    return table_;
  }

  it("resolves the hero's name and the spell's name from the glossary", async () => {
    const narrator = new ScriptedNarrator([], [], [], [], [{ text: "A faint blue aura clings to the old ledger on the bar." }]);
    const { store, worker } = await tableWithAUtilityCast(narrator);
    expect(await worker.runOnce()).toEqual({ processed: 1, failed: [] });

    expect(narrator.utilityCastRequests[0]).toMatchObject({ heroName: "Rowan", spell: { id: "spell:detect-magic", name: "Detect Magic" } });
    const log = await events(store);
    expect(log).toContainEqual({ kind: "utilityCastNarrated", castId: "cast:1", text: "A faint blue aura clings to the old ledger on the bar." });
  });

  it("falls back to a template line once the Narrator's attempts are spent", async () => {
    const narrator = new ScriptedNarrator([], [], [], [], [new Error("rate limited"), new Error("rate limited")]);
    const { store, worker } = await tableWithAUtilityCast(narrator);
    expect(await worker.runOnce()).toMatchObject({ processed: 0, failed: [{ error: "rate limited" }] });
    expect(await worker.runOnce()).toEqual({ processed: 1, failed: [] });
    const log = await events(store);
    expect(log).toContainEqual({ kind: "utilityCastNarrated", castId: "cast:1", text: "Rowan casts Detect Magic." });
  });
});

describe("narrateHazard", () => {
  async function tableWithAHazard(narrator: ScriptedNarrator): Promise<Table> {
    const state = { ...startState(), characters: { ...startState().characters, "c-rowan": rowan } };
    const table_ = await table(new ScriptedPlanner([]), narrator, state);
    await table_.bus.execute(key, { kind: "faceHazard", characterId: "c-rowan", ability: "con", dc: 5 }, { commandId: "hazard-1", actor: organizer });
    const stored = await table_.store.transaction((tx) => tx.loadCampaign(key));
    const pending = stored?.state.hazardPending?.["c-rowan"];
    if (pending === undefined) throw new Error("Expected a pending hazard.");
    // Rowan's CON 14 (+2), no save proficiency, no Exhaustion yet: a natural 20 always clears DC 5.
    const roll = d20Roll("normal", [20], 2);
    await table_.bus.execute(key, { kind: "recordRoll", rollId: pending.rollId, result: { kind: "d20Test", roll } }, { commandId: "hazard-roll-1", actor: system });
    return table_;
  }

  it("resolves the hero's name and the save's ability from the check label", async () => {
    const narrator = new ScriptedNarrator([], [], [], [], [], [{ text: "Rowan shrugs off the biting cold." }]);
    const { store, worker } = await tableWithAHazard(narrator);
    expect(await worker.runOnce()).toEqual({ processed: 1, failed: [] });

    expect(narrator.hazardRequests[0]).toMatchObject({ heroName: "Rowan", ability: "con check", dc: 5, total: 22, success: true, exhaustionGained: 0 });
    const log = await events(store);
    expect(log).toContainEqual({ kind: "hazardNarrated", hazardId: "hazard:1", text: "Rowan shrugs off the biting cold." });
  });

  it("falls back to a template line once the Narrator's attempts are spent", async () => {
    const narrator = new ScriptedNarrator([], [], [], [], [], [new Error("rate limited"), new Error("rate limited")]);
    const { store, worker } = await tableWithAHazard(narrator);
    expect(await worker.runOnce()).toMatchObject({ processed: 0, failed: [{ error: "rate limited" }] });
    expect(await worker.runOnce()).toEqual({ processed: 1, failed: [] });
    const log = await events(store);
    expect(log).toContainEqual({ kind: "hazardNarrated", hazardId: "hazard:1", text: "Rowan pushes through the ordeal unscathed." });
  });
});

describe("the opening", () => {
  it("has the Narrator open the adventure with the party, then waits for the table and opens the first round", async () => {
    const narrator = new ScriptedNarrator([{ text: "Welcome to the Crossroads Inn. What do you do?" }]);
    const t = await table(new ScriptedPlanner([]), narrator);
    await t.bus.execute(key, { kind: "beginAdventure" }, { commandId: "b1", actor: system });
    expect(await t.worker.runOnce()).toEqual({ processed: 1, failed: [] });

    expect(narrator.requests).toHaveLength(1);
    expect(narrator.requests[0]).toMatchObject({ roundNumber: 0, outcomes: [] });
    expect(narrator.requests[0]?.opening?.heroes.map((hero) => hero.name)).toContain("Mira");
    const log = await events(t.store);
    expect(log.map((event) => event.kind)).toEqual(expect.arrayContaining(["adventureBegan", "openingRecorded"]));
    const stored = await t.store.transaction((tx) => tx.loadCampaign(key));
    expect(stored?.state).toMatchObject({ opening: "waiting", round: null });
    // The first round opens once the players are ready.
    await t.bus.execute(key, { kind: "ready" }, { commandId: "r1", actor: alex });
    await t.bus.execute(key, { kind: "ready" }, { commandId: "r2", actor: jamie });
    expect((await t.store.transaction((tx) => tx.loadCampaign(key)))?.state).toMatchObject({ opening: "done", round: { number: 1, status: "collecting" } });
  });

  it("falls back to the adventure's own text when the Narrator keeps failing, so the table can start", async () => {
    const narrator = new ScriptedNarrator([new Error("provider down"), new Error("provider down")]);
    const t = await table(new ScriptedPlanner([]), narrator);
    await t.bus.execute(key, { kind: "beginAdventure" }, { commandId: "b1", actor: system });
    await t.worker.runOnce();
    await t.worker.runOnce();
    const opening = (await events(t.store)).find((event) => event.kind === "openingRecorded");
    expect(opening?.kind === "openingRecorded" ? opening.text : "").toContain(testBible.premise);
    expect(opening?.kind === "openingRecorded" ? opening.text : "").toContain("What do you do?");
    const stored = await t.store.transaction((tx) => tx.loadCampaign(key));
    expect(stored?.state).toMatchObject({ opening: "waiting", round: null });
  });
});
