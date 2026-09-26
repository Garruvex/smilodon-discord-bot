import { describe, expect, it } from "vitest";

import { CampaignCommandBus, type CommandMeta } from "../../../src/application/campaign/campaign-command-bus.js";
import {
  RevisionConflictError,
  type CampaignKey,
  type CampaignTransaction,
  type CampaignUnitOfWork,
  type CommandOutcome,
} from "../../../src/application/campaign/ports/campaign-store.js";
import { SeededRandomSource } from "../../../src/application/campaign/random/seeded-random-source.js";
import { RulesetCatalog } from "../../../src/application/campaign/rules/ruleset-catalog.js";
import { ManualClock } from "../../../src/application/campaign/time/manual-clock.js";
import { RollWorker } from "../../../src/application/campaign/workers/roll-worker.js";
import { TimerWorker } from "../../../src/application/campaign/workers/timer-worker.js";
import type { CampaignCommand } from "../../../src/domain/campaign/commands/campaign-command.js";
import type { RandomSource } from "../../../src/domain/campaign/dice/random-source.js";
import { InMemoryCampaignStore } from "../../../src/infrastructure/persistence/campaign/in-memory-campaign-store.js";
import { alex, jamie, newCampaign, organizer, ruleset, system } from "../../domain/campaign/campaign-fixtures.js";

const key: CampaignKey = { guildId: "g-1", campaignId: "camp-1" };

interface Harness {
  readonly store: InMemoryCampaignStore;
  readonly clock: ManualClock;
  readonly bus: CampaignCommandBus;
  readonly queued: CampaignKey[];
}

async function setup(unitOfWork?: (store: InMemoryCampaignStore) => CampaignUnitOfWork): Promise<Harness> {
  const store = new InMemoryCampaignStore();
  const clock = new ManualClock(0);
  const queued: CampaignKey[] = [];
  const content = ruleset().content;
  const bus = new CampaignCommandBus({
    unitOfWork: unitOfWork?.(store) ?? store,
    rulesets: new RulesetCatalog([content]),
    clock,
    onWorkQueued: (queuedKey): void => {
      queued.push(queuedKey);
    },
  });
  await store.transaction((tx) =>
    tx.createCampaign(key, {
      state: newCampaign(),
      revision: 0,
      ruleset: { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} },
      adventure: { adventureId: "test-adventure", version: "1" },
    }),
  );
  return { store, clock, bus, queued };
}

let nextId = 0;
function meta(actor: CommandMeta["actor"], commandId = `cmd-${++nextId}`): CommandMeta {
  return { commandId, actor };
}

async function load(store: InMemoryCampaignStore, campaign: CampaignKey = key): ReturnType<CampaignTransaction["loadCampaign"]> {
  return store.transaction((tx) => tx.loadCampaign(campaign));
}

// Opens round 1, Mira acts, Borin passes, and the plan gives Mira a Stealth check.
async function playToPendingCheck(harness: Harness): Promise<void> {
  const { bus } = harness;
  await bus.execute(key, { kind: "openRound" }, meta(system));
  await bus.execute(key, { kind: "submitAction", characterId: "c-mira", text: "I sneak past." }, meta(alex));
  await bus.execute(key, { kind: "pass", characterId: "c-borin" }, meta(jamie));
  const planned = await bus.execute(
    key,
    {
      kind: "applyRoundPlan",
      proposal: {
        roundNumber: 1,
        actions: [
          {
            characterId: "c-mira",
            resolution: { kind: "check", test: { kind: "skill", skill: "stealth" }, dcTier: "medium", rollModeReasons: [] },
          },
        ],
      },
    },
    meta(system),
  );
  expect(planned.kind).toBe("accepted");
}

// Counts how many dice were rolled, to prove a retry never rolls again.
function countingRandom(seed: number): RandomSource & { calls: number } {
  const inner = new SeededRandomSource(seed);
  const counter = {
    calls: 0,
    nextInt(min: number, max: number): number {
      counter.calls += 1;
      return inner.nextInt(min, max);
    },
  };
  return counter;
}

describe("CampaignCommandBus", () => {
  it("saves state, events with their envelope, and timers in one commit", async () => {
    const harness = await setup();
    harness.clock.advance(5_000);
    const outcome = await harness.bus.execute(key, { kind: "openRound" }, meta(system, "open-1"));
    expect(outcome).toEqual({ kind: "accepted", revision: 1, eventCount: 1 });

    const stored = await load(harness.store);
    expect(stored?.revision).toBe(1);
    expect(stored?.state.round?.number).toBe(1);
    const events = await harness.store.transaction((tx) => tx.readEvents(key));
    expect(events).toEqual([
      {
        campaignId: "camp-1",
        sequence: 1,
        causationId: "open-1",
        commandKind: "openRound",
        actor: system,
        rulesRevision: "srd-5.1@2026.1",
        recordedAt: 5_000,
        event: { kind: "roundOpened", roundNumber: 1, participants: ["c-mira", "c-borin"], closesAt: 305_000 },
      },
    ]);
    const timers = await harness.store.transaction((tx) => tx.dueTimers(305_000));
    expect(timers.map((record) => record.timer.timerId)).toEqual(["round:1"]);
    expect(harness.queued).toEqual([key]);
  });

  it("returns the first outcome for a repeated command ID and changes nothing", async () => {
    const harness = await setup();
    const first = await harness.bus.execute(key, { kind: "openRound" }, meta(system, "same"));
    const again = await harness.bus.execute(key, { kind: "openRound" }, meta(system, "same"));
    expect(again).toEqual(first);
    expect((await load(harness.store))?.revision).toBe(1);
    expect(await harness.store.transaction((tx) => tx.readEvents(key))).toHaveLength(1);
  });

  it("saves nothing for a rejected command", async () => {
    const harness = await setup();
    const outcome = await harness.bus.execute(key, { kind: "closeRound" }, meta(alex));
    expect(outcome).toEqual({ kind: "rejected", rejection: { code: "notOrganizer" } });
    expect((await load(harness.store))?.revision).toBe(0);
    expect(await harness.store.transaction((tx) => tx.readEvents(key))).toEqual([]);
  });

  it("cannot reach a campaign through another guild", async () => {
    const harness = await setup();
    const otherGuild: CampaignKey = { guildId: "g-2", campaignId: "camp-1" };
    expect(await harness.bus.execute(otherGuild, { kind: "openRound" }, meta(system))).toEqual({ kind: "notFound" });
    expect(await load(harness.store, otherGuild)).toBeUndefined();
  });

  it("decides again once when another writer moved the revision", async () => {
    let conflicts = 1;
    const harness = await setup((store) => ({
      transaction: <T>(work: (tx: CampaignTransaction) => Promise<T>): Promise<T> =>
        store.transaction((tx) =>
          work({
            ...bindAll(tx),
            saveCampaign: async (campaign, state, expected) => {
              if (conflicts-- > 0) throw new RevisionConflictError(campaign, expected, expected + 1);
              return tx.saveCampaign(campaign, state, expected);
            },
          }),
        ),
    }));
    const outcome = await harness.bus.execute(key, { kind: "openRound" }, meta(system));
    expect(outcome).toEqual({ kind: "accepted", revision: 1, eventCount: 1 });
    expect(await harness.store.transaction((tx) => tx.readEvents(key))).toHaveLength(1);
  });

  it("rolls back every write when a transaction fails part-way", async () => {
    const harness = await setup();
    await expect(
      harness.store.transaction(async (tx) => {
        await tx.recordProcessedCommand(key, "doomed", { kind: "notFound" });
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    expect(await harness.store.transaction((tx) => tx.findProcessedCommand(key, "doomed"))).toBeUndefined();
  });

  it("runs commands for one campaign one at a time", async () => {
    const harness = await setup();
    await harness.bus.execute(key, { kind: "openRound" }, meta(system));
    const outcomes = await Promise.all([
      harness.bus.execute(key, { kind: "submitAction", characterId: "c-mira", text: "Left door." }, meta(alex)),
      harness.bus.execute(key, { kind: "submitAction", characterId: "c-mira", text: "Right door." }, meta(alex)),
    ]);
    expect(outcomes.map((outcome: CommandOutcome) => outcome.kind)).toEqual(["accepted", "accepted"]);
    const stored = await load(harness.store);
    expect(stored?.revision).toBe(3);
    expect(stored?.state.round?.submissions["c-mira"]).toEqual({ kind: "action", text: "Right door.", revision: 2 });
  });
});

describe("RollWorker", () => {
  it("rolls a requested check once, records it, and queues the result and narration", async () => {
    const harness = await setup();
    await playToPendingCheck(harness);
    await harness.bus.execute(key, { kind: "requestRoll", checkId: "r1:c-mira" }, meta(alex));
    const random = countingRandom(3);
    const worker = new RollWorker(harness.store, harness.bus, random, harness.clock);

    expect(await worker.runOnce()).toEqual({ processed: 1, failed: [] });
    const stored = await load(harness.store);
    expect(stored?.state.round).toBeNull();
    const narrate = await harness.store.transaction((tx) => tx.pendingOutbox("narrate"));
    expect(narrate.map((item) => item.request)).toEqual([{ kind: "narrate", roundNumber: 1 }]);
    const results = await harness.store.transaction((tx) => tx.pendingOutbox("deliver"));
    expect(results.map((item) => item.request)).toContainEqual({ kind: "deliver", delivery: { kind: "rollResult", checkId: "r1:c-mira" } });

    expect(await worker.runOnce()).toEqual({ processed: 0, failed: [] });
    expect(random.calls).toBe(1);
  });

  it("re-delivers the saved roll after a failure instead of rolling again", async () => {
    const harness = await setup();
    await playToPendingCheck(harness);
    await harness.bus.execute(key, { kind: "requestRoll", checkId: "r1:c-mira" }, meta(alex));

    let failures = 1;
    const flakyBus = new (class extends CampaignCommandBus {
      public override async execute(campaign: CampaignKey, command: CampaignCommand, commandMeta: CommandMeta): Promise<CommandOutcome> {
        if (failures-- > 0) throw new Error("connection reset");
        return super.execute(campaign, command, commandMeta);
      }
    })({ unitOfWork: harness.store, rulesets: new RulesetCatalog([ruleset().content]), clock: harness.clock });
    const random = countingRandom(11);
    const worker = new RollWorker(harness.store, flakyBus, random, harness.clock);

    expect(await worker.runOnce()).toMatchObject({ processed: 0, failed: [{ error: "connection reset" }] });
    const saved = await harness.store.transaction((tx) => tx.findRoll(key, "r1:c-mira:roll"));
    expect(await worker.runOnce()).toEqual({ processed: 1, failed: [] });
    expect(random.calls).toBe(1);

    const check = (await load(harness.store))?.state.checks["r1:c-mira"];
    expect(saved?.result).toEqual({ kind: "d20Test", roll: check?.result?.roll });
  });
});

describe("TimerWorker", () => {
  it("closes the round when its window expires, and fires each timer once", async () => {
    const harness = await setup();
    const timers = new TimerWorker(harness.store, harness.bus, harness.clock);
    await harness.bus.execute(key, { kind: "openRound" }, meta(system));
    await harness.bus.execute(key, { kind: "submitAction", characterId: "c-mira", text: "I wait." }, meta(alex));

    harness.clock.advance(299_999);
    expect(await timers.runOnce()).toEqual({ processed: 0, failed: [] });
    harness.clock.advance(1);
    expect(await timers.runOnce()).toEqual({ processed: 1, failed: [] });

    const stored = await load(harness.store);
    expect(stored?.state.round?.status).toBe("planning");
    expect(stored?.state.round?.submissions["c-borin"]).toEqual({ kind: "missed" });
    expect(stored?.state.members["u-jamie"]?.consecutiveMisses).toBe(1);
    expect(await timers.runOnce()).toEqual({ processed: 0, failed: [] });
  });

  it("never fires a window timer cancelled by everyone responding first", async () => {
    const harness = await setup();
    const timers = new TimerWorker(harness.store, harness.bus, harness.clock);
    await harness.bus.execute(key, { kind: "openRound" }, meta(system));
    await harness.bus.execute(key, { kind: "pass", characterId: "c-mira" }, meta(alex));
    await harness.bus.execute(key, { kind: "pass", characterId: "c-borin" }, meta(jamie));
    harness.clock.advance(600_000);
    expect(await timers.runOnce()).toEqual({ processed: 0, failed: [] });
  });

  it("auto-rolls a pending check when its roll timer expires, labeled as timed out", async () => {
    const harness = await setup();
    await playToPendingCheck(harness);
    const timers = new TimerWorker(harness.store, harness.bus, harness.clock);
    const rolls = new RollWorker(harness.store, harness.bus, new SeededRandomSource(5), harness.clock);

    harness.clock.advance(120_000);
    expect(await timers.runOnce()).toEqual({ processed: 1, failed: [] });
    expect(await rolls.runOnce()).toEqual({ processed: 1, failed: [] });

    const events = await harness.store.transaction((tx) => tx.readEvents(key));
    expect(events.map((envelope) => envelope.event)).toContainEqual({
      kind: "checkRollStarted",
      checkId: "r1:c-mira",
      rollId: "r1:c-mira:roll",
      timedOut: true,
    });
    expect(events.at(-1)?.event).toEqual({ kind: "roundResolved", roundNumber: 1, quiet: false });
    // The player's late click is refused; the saved result stands.
    const late = await harness.bus.execute(key, { kind: "requestRoll", checkId: "r1:c-mira" }, meta(alex));
    expect(late).toEqual({ kind: "rejected", rejection: { code: "checkNotPending" } });
  });

  it("does not let the organizer's close count as a timer miss", async () => {
    const harness = await setup();
    await harness.bus.execute(key, { kind: "openRound" }, meta(system));
    await harness.bus.execute(key, { kind: "closeRound" }, meta(organizer));
    expect((await load(harness.store))?.state.members["u-jamie"]?.consecutiveMisses).toBe(0);
  });
});

// Spreading a class instance loses its prototype methods, so bind each one.
function bindAll(tx: CampaignTransaction): CampaignTransaction {
  const bound: Partial<Record<keyof CampaignTransaction, unknown>> = {};
  let proto: object | null = Object.getPrototypeOf(tx) as object | null;
  while (proto !== null && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      const value: unknown = (tx as unknown as Record<string, unknown>)[name];
      if (name !== "constructor" && typeof value === "function") {
        bound[name as keyof CampaignTransaction] = (value as (...args: unknown[]) => unknown).bind(tx);
      }
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return bound as CampaignTransaction;
}
