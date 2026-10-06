import { describe, expect, it } from "vitest";

import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { rig, starter, startedCampaign, type Rig } from "./campaign-rig.js";

// Plan §13, acceptance scenarios that cut across the engine, the store and the
// workers. The scenarios that live entirely in one layer are tested there.

const player = { kind: "user", userId: "u-org" } as const;
const stateOf = async (r: Rig, key: Awaited<ReturnType<typeof startedCampaign>>): Promise<CampaignState> => {
  const stored = await r.store.transaction((tx) => tx.loadCampaign(key));
  if (stored === undefined) throw new Error("state");
  return stored.state;
};

describe("scenario 13: two simultaneous actions on one campaign are serialized", () => {
  it("applies both in order, and a repeated command changes nothing", async () => {
    const r = rig();
    const key = await startedCampaign(r);
    const hero = starter.en.heroes[0]?.id ?? "";
    const before = (await r.store.transaction((tx) => tx.loadCampaign(key)))?.revision ?? 0;
    // One player at the table: the first action closes the round, so the second finds it closed.
    const [first, second] = await Promise.all([
      r.bus.execute(key, { kind: "submitAction", characterId: hero, text: "I go left." }, { commandId: "a", actor: player }),
      r.bus.execute(key, { kind: "submitAction", characterId: hero, text: "I go right." }, { commandId: "b", actor: player }),
    ]);
    expect(first.kind).toBe("accepted");
    expect(second).toEqual({ kind: "rejected", rejection: { code: "roundNotCollecting" } });
    const state = await stateOf(r, key);
    // The second did not overwrite what the first committed.
    expect(state.round?.submissions[hero]).toMatchObject({ kind: "action", text: "I go left.", revision: 1 });
    const after = (await r.store.transaction((tx) => tx.loadCampaign(key)))?.revision ?? 0;
    expect(after).toBeGreaterThan(before);

    // The same button pressed again (a retry, a double click) is answered with the first result and changes nothing.
    const again = await r.bus.execute(key, { kind: "submitAction", characterId: hero, text: "I go left." }, { commandId: "a", actor: player });
    expect(again).toEqual(first);
    expect((await r.store.transaction((tx) => tx.loadCampaign(key)))?.revision).toBe(after);
  });
});

describe("scenario 34: an all-away party creates no empty-round loop, and recovery never plays unattended rounds", () => {
  it("holds play while everyone is away, however long it takes, and picks up when someone returns", async () => {
    const r = rig();
    const key = await startedCampaign(r);
    const runtime = r.runtime();
    await runtime.runOnce();
    const opened = (await stateOf(r, key)).lastRoundNumber;

    await r.bus.execute(key, { kind: "markAway", userId: "u-org" }, { commandId: "away", actor: player });
    for (let day = 0; day < 4; day += 1) {
      r.clock.advance(24 * 3600 * 1000);
      await runtime.runOnce();
    }
    const held = await stateOf(r, key);
    expect(held.status).toBe("waitingForPlayers");
    // No round was opened or closed while nobody was there.
    expect(held.lastRoundNumber).toBe(opened);
    expect(held.round?.submissions ?? {}).toEqual({});

    // A restart in the middle changes nothing: recovery pauses, it does not play.
    const restarted = r.runtime("boot-2");
    await restarted.recover();
    r.clock.advance(24 * 3600 * 1000);
    await restarted.runOnce();
    expect((await stateOf(r, key)).lastRoundNumber).toBe(opened);

    await r.bus.execute(key, { kind: "markReturned", userId: "u-org" }, { commandId: "back", actor: player });
    await r.bus.execute(key, { kind: "continue" }, { commandId: "go", actor: player });
    expect((await stateOf(r, key)).status).toBe("active");
  });
});
