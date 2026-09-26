import { describe, expect, it } from "vitest";

import type { EngineRequest, ReminderTarget } from "../../../src/domain/campaign/engine/engine-request.js";
import { minReminderWindowMs } from "../../../src/domain/campaign/engine/reminders.js";
import type { Pacing } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, jamie, kinds, livePacing, newCampaign, organizer, reject, run, system } from "./campaign-fixtures.js";
import { startedFight } from "./combat-fixtures.js";

const daily: Pacing = { roundSeconds: 24 * 3600, rollSeconds: 12 * 3600, turnSeconds: 12 * 3600, awayAfterMisses: 2 };
const half = (seconds: number): number => (seconds * 1000) / 2;
const reminders = (requests: readonly EngineRequest[]): { dueAt: number; target: ReminderTarget }[] =>
  requests.flatMap((request) => (request.kind === "startTimer" && request.timer.kind === "reminder" ? [{ dueAt: request.timer.dueAt, target: request.timer.target }] : []));

describe("halfway reminders", () => {
  it("are asked for when a long round window opens, at the halfway point", () => {
    const opened = run(newCampaign(daily), system, { kind: "openRound" }, { now: 1_000 });
    const round = opened.state.round;
    expect(reminders(opened.requests)).toEqual([
      { dueAt: 1_000 + half(daily.roundSeconds ?? 0), target: { kind: "round", roundNumber: 1, closesAt: round?.closesAt } },
    ]);
  });

  it("are not asked for short windows, where the panel's countdown is enough", () => {
    const opened = run(newCampaign(livePacing), system, { kind: "openRound" }, { now: 1_000 });
    expect(reminders(opened.requests)).toEqual([]);
    expect((livePacing.roundSeconds ?? 0) * 1000).toBeLessThan(minReminderWindowMs);
    // Nor without a timer at all.
    expect(reminders(run(newCampaign({ ...daily, roundSeconds: null }), system, { kind: "openRound" }).requests)).toEqual([]);
  });

  it("nudge the table while the round is still waiting, without changing anything", () => {
    const opened = run(newCampaign(daily), system, { kind: "openRound" }, { now: 0 });
    const [reminder] = reminders(opened.requests);
    if (reminder === undefined) throw new Error("reminder");
    const fired = run(opened.state, system, { kind: "timerReminder", target: reminder.target }, { now: reminder.dueAt });
    expect(fired.events).toEqual([]);
    expect(fired.state).toEqual(opened.state);
    expect(fired.requests).toEqual([{ kind: "deliver", delivery: { kind: "timerReminder", target: reminder.target } }]);
  });

  it("do nothing once the round has moved on, was answered, paused, or its deadline moved", () => {
    const opened = run(newCampaign(daily), system, { kind: "openRound" }, { now: 0 });
    const target: ReminderTarget = { kind: "round", roundNumber: 1, closesAt: opened.state.round?.closesAt ?? 0 };
    const nothing = (state: typeof opened.state, wanted: ReminderTarget = target): void => {
      const fired = run(state, system, { kind: "timerReminder", target: wanted }, { now: 1 });
      expect(fired.requests).toEqual([]);
    };
    // A different deadline: the round was paused and resumed since.
    nothing(opened.state, { ...target, closesAt: target.closesAt + 1 });
    nothing(opened.state, { ...target, roundNumber: 2 });
    const paused = run(opened.state, organizer, { kind: "pauseCampaign", reason: "organizer" }).state;
    nothing(paused);
    // Everyone answered: the round closed.
    const answered = run(run(opened.state, alex, { kind: "pass", characterId: "c-mira" }).state, jamie, { kind: "pass", characterId: "c-borin" });
    expect(kinds(answered.events)).toContain("roundClosed");
    nothing(answered.state);
  });

  it("are for the system only", () => {
    const opened = run(newCampaign(daily), system, { kind: "openRound" });
    expect(reject(opened.state, alex, { kind: "timerReminder", target: { kind: "round", roundNumber: 1, closesAt: 0 } })).toEqual({ code: "systemOnly" });
  });

  it("are asked for again when a pause is lifted, for the new deadline", () => {
    const opened = run(newCampaign(daily), system, { kind: "openRound" }, { now: 0 });
    const paused = run(opened.state, organizer, { kind: "pauseCampaign", reason: "organizer" }, { now: 1_000 });
    const resumed = run(paused.state, organizer, { kind: "continue" }, { now: 5_000 });
    const [again] = reminders(resumed.requests);
    expect(again?.target).toMatchObject({ kind: "round", roundNumber: 1 });
    expect(again?.dueAt).toBe(5_000 + half(daily.roundSeconds ?? 0));
    expect(again?.target).toEqual({ kind: "round", roundNumber: 1, closesAt: 5_000 + (daily.roundSeconds ?? 0) * 1000 });
  });

  it("cover a long turn in a fight, for the hero whose turn it is", () => {
    const fight = startedFight(newCampaign(daily));
    const turn = fight.state.encounter;
    expect(turn?.turnEndsAt).not.toBeNull();
    const target: ReminderTarget = { kind: "turn", encounterId: turn?.id ?? "", turnNumber: turn?.turnNumber ?? 0, endsAt: turn?.turnEndsAt ?? 0 };
    const fired = run(fight.state, system, { kind: "timerReminder", target });
    expect(fired.requests).toEqual([{ kind: "deliver", delivery: { kind: "timerReminder", target } }]);
  });
});
