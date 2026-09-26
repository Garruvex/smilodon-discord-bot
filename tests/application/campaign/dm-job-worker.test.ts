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
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { InMemoryCampaignStore } from "../../../src/infrastructure/persistence/campaign/in-memory-campaign-store.js";
import { alex, jamie, newCampaign, organizer, ruleset, run, system } from "../../domain/campaign/campaign-fixtures.js";
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
      text: "The wind howls through the ruins. ".repeat(20),
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

  it("holds the round for the organizer after two failed attempts, applying nothing", async () => {
    const planner = new ScriptedPlanner([offLadder, new Error("provider timeout")]);
    const { store, bus, worker } = await table(planner, new ScriptedNarrator([]));
    await closeRoundOne(bus);
    expect(await worker.runOnce()).toEqual({ processed: 1, failed: [] });

    const log = await events(store);
    expect(log.at(-1)).toEqual({ kind: "plannerFailed", roundNumber: 1, problems: ["The planner call failed: provider timeout"] });
    expect(log.some((event) => event.kind === "roundPlanApplied")).toBe(false);
    const deliveries = await store.transaction((tx) => tx.pendingOutbox("deliver"));
    expect(deliveries.map((item) => item.request)).toContainEqual({
      kind: "deliver",
      delivery: { kind: "organizerNotice", notice: "plannerFailed", roundNumber: 1 },
    });

    // The organizer's retry queues a fresh planner job.
    planner.requests.length = 0;
    const retry = new ScriptedPlanner([sneak]);
    await bus.execute(key, { kind: "retryPlan" }, { commandId: "retry", actor: organizer });
    const retried = new DmJobWorker({
      unitOfWork: store,
      bus,
      planner: retry,
      narrator: new ScriptedNarrator([]),
      adventures: { find: (): AdventureBible => testBible },
      glossaries: { en: enSrd51Glossary },
    });
    await retried.runOnce();
    expect((await store.transaction((tx) => tx.loadCampaign(key)))?.state.round?.status).toBe("resolving");
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
