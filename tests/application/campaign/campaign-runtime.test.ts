import { describe, expect, it } from "vitest";

import { DeliveryWorker } from "../../../src/application/campaign/workers/delivery-worker.js";
import { starterAdventureId } from "../../../src/infrastructure/campaign/starter-adventures.js";
import { ruleset } from "../../domain/campaign/campaign-fixtures.js";
import { guildId, rig, starter, startedCampaign } from "./campaign-rig.js";

const player = { kind: "user", userId: "u-org" } as const;

describe("the runtime", () => {
  it("drives a round from the player's action to narration and the next round, delivering each step", async () => {
    const r = rig();
    const key = await startedCampaign(r);
    const heroId = starter.en.heroes[0]?.id ?? "";
    r.plannerScript.push({ roundNumber: 1, actions: [{ characterId: heroId, resolution: { kind: "automatic", reason: "Simple." } }] });

    await r.bus.execute(key, { kind: "submitAction", characterId: heroId, text: "I greet the innkeeper." }, { commandId: "act-1", actor: player });
    const runtime = r.runtime();
    await runtime.runOnce();
    await runtime.runOnce();

    const state = (await r.store.transaction((tx) => tx.loadCampaign(key)))?.state;
    expect(state?.lastNarratedRound).toBe(1);
    expect(state?.round).toMatchObject({ number: 2, status: "collecting" });
    expect(r.presenter.delivered.map((delivery) => delivery.kind)).toContain("narration");
  });

  it("keeps a campaign's deliveries in order and retries a failed one before the next", async () => {
    const r = rig();
    const key = await startedCampaign(r);
    await r.store.transaction(async (tx) => {
      await tx.enqueue(key, "d1", { kind: "deliver", delivery: { kind: "quietRound", roundNumber: 1 } }, 1);
      await tx.enqueue(key, "d2", { kind: "deliver", delivery: { kind: "narration", roundNumber: 1 } }, 2);
    });
    const worker = new DeliveryWorker(r.store, r.presenter, 3);
    r.presenter.failNext = 1;
    // The first fails, so the second waits behind it.
    expect((await worker.runOnce()).failed).toHaveLength(1);
    expect(r.presenter.delivered.filter((delivery) => delivery.kind === "narration")).toHaveLength(0);
    await worker.runOnce();
    const kinds = r.presenter.delivered.map((delivery) => delivery.kind);
    expect(kinds.indexOf("quietRound")).toBeLessThan(kinds.indexOf("narration"));
  });

  it("gives up on a delivery after its attempts, without blocking forever", async () => {
    const r = rig();
    const key = await startedCampaign(r);
    await r.store.transaction((tx) => tx.enqueue(key, "d1", { kind: "deliver", delivery: { kind: "quietRound", roundNumber: 1 } }, 1));
    const worker = new DeliveryWorker(r.store, r.presenter, 2);
    r.presenter.failNext = 5;
    await worker.runOnce();
    await worker.runOnce();
    r.presenter.failNext = 0;
    await worker.runOnce();
    expect(r.presenter.delivered.filter((delivery) => delivery.kind === "quietRound")).toHaveLength(0);
  });
});

describe("recovery after a restart", () => {
  it("pauses timed campaigns so no deadline fires unattended, until the organizer resumes", async () => {
    const r = rig();
    const key = await startedCampaign(r);
    const restarted = r.runtime("boot-2");
    const report = await restarted.recover();
    expect(report.paused).toEqual([key]);

    // Hours later nothing fires, because the timers were cancelled.
    r.clock.advance(6 * 3600 * 1000);
    await restarted.runOnce();
    const paused = (await r.store.transaction((tx) => tx.loadCampaign(key)))?.state;
    expect(paused).toMatchObject({ status: "waitingForPlayers", pausedBy: "recovery" });
    expect(paused?.round?.submissions).toEqual({});

    const resumed = await r.bus.execute(key, { kind: "continue" }, { commandId: "resume", actor: { kind: "user", userId: "u-org" } });
    expect(resumed.kind).toBe("accepted");
    const after = (await r.store.transaction((tx) => tx.loadCampaign(key)))?.state;
    expect(after).toMatchObject({ status: "active", pausedBy: null });
  });

  it("does not pause a campaign twice for one start, and pauses again after the next", async () => {
    const r = rig();
    const key = await startedCampaign(r);
    await r.runtime("boot-2").recover();
    await r.bus.execute(key, { kind: "continue" }, { commandId: "resume", actor: { kind: "user", userId: "u-org" } });
    expect((await r.runtime("boot-2").recover()).paused).toEqual([key]);
    await r.bus.execute(key, { kind: "continue" }, { commandId: "resume-2", actor: { kind: "user", userId: "u-org" } });
    expect((await r.runtime("boot-3").recover()).paused).toEqual([key]);
  });

  it("opens the first round of a campaign that stopped before it, and leaves untimed campaigns running", async () => {
    const r = rig();
    const created = await r.service.create({
      guildId,
      organizerId: "u-org",
      name: "Untimed",
      language: "en",
      adventureId: starterAdventureId,
      pacing: { preset: "custom", pacing: { roundSeconds: null, rollSeconds: null, turnSeconds: null, awayAfterMisses: 2 } },
    });
    if (created.kind !== "ok") throw new Error("create");
    const { key } = created.value;
    await r.service.join(key, "u-org");
    await r.service.chooseHero(key, "u-org", starter.en.heroes[0]?.id ?? "");
    // Simulate the crash: the engine campaign exists but the first round never opened.
    await r.store.transaction(async (tx) => {
      const stored = await tx.loadRecord(key);
      if (stored === undefined) throw new Error("record");
      await tx.saveRecord({ ...stored.record, lifecycle: "active", lobby: { ...stored.record.lobby, status: "started" }, startedAt: 1 }, stored.revision);
    });
    const { buildStartingState } = await import("../../../src/application/campaign/setup/starting-state.js");
    await r.store.transaction((tx) =>
      tx.createCampaign(key, {
        state: buildStartingState({
          campaignId: key.campaignId,
          organizerId: "u-org",
          adventure: starter.en,
          seats: [{ userId: "u-org", heroId: starter.en.heroes[0]?.id ?? "" }],
          pacing: { roundSeconds: null, rollSeconds: null, turnSeconds: null, awayAfterMisses: 2 },
        }),
        revision: 0,
        ruleset: { rulesetId: ruleset().content.rulesetId, rulesetVersion: ruleset().content.version, houseRules: {} },
        adventure: { adventureId: starterAdventureId, version: starter.en.bible.version },
      }),
    );
    const report = await r.runtime().recover();
    expect(report.firstRoundsOpened).toEqual([key]);
    expect(report.paused).toEqual([]);
    const state = (await r.store.transaction((tx) => tx.loadCampaign(key)))?.state;
    expect(state).toMatchObject({ status: "active", pausedBy: null, round: { number: 1, status: "collecting" } });
  });
});
