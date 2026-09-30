import { describe, expect, it } from "vitest";

import type { PlannedEffect, RoundPlanProposal } from "../../../src/domain/campaign/commands/campaign-command.js";
import { changedWorld, type WorldState } from "../../../src/domain/campaign/state/world-state.js";
import { alex, jamie, newCampaign, organizer, partyOfThree, run, system } from "./campaign-fixtures.js";

// The story's own day, time and weather: it moves when the story says so, and only then.

const dusk: WorldState = { day: 2, time: "dusk", weather: "rain" };
const started = { ...partyOfThree(), world: dusk };

describe("the world's clock", () => {
  it("passes phases of the day and rolls over into the next day", () => {
    expect(changedWorld(dusk, { kind: "advance", steps: 1 })).toEqual({ day: 2, time: "night", weather: "rain" });
    expect(changedWorld(dusk, { kind: "advance", steps: 2 })).toEqual({ day: 3, time: "dawn", weather: "rain" });
    expect(changedWorld(dusk, { kind: "advance", steps: 12 })).toEqual({ day: 4, time: "dusk", weather: "rain" });
  });

  it("takes a short rest as one phase and a long rest to the next dawn", () => {
    expect(changedWorld(dusk, { kind: "rest", rest: "short" })).toMatchObject({ day: 2, time: "night" });
    expect(changedWorld(dusk, { kind: "rest", rest: "long" })).toMatchObject({ day: 3, time: "dawn" });
    expect(changedWorld({ day: 1, time: "dawn" }, { kind: "rest", rest: "long" })).toMatchObject({ day: 2, time: "dawn" });
  });

  it("changes the sky, sets what it is told, and reports nothing when nothing changed", () => {
    expect(changedWorld(dusk, { kind: "weather", weather: "fog" })).toEqual({ day: 2, time: "dusk", weather: "fog" });
    expect(changedWorld(dusk, { kind: "weather", weather: null })).toEqual({ day: 2, time: "dusk" });
    expect(changedWorld(dusk, { kind: "set", time: "dawn" })).toEqual({ day: 2, time: "dawn", weather: "rain" });
    expect(changedWorld(dusk, { kind: "weather", weather: "rain" })).toBeNull();
  });
});

describe("the world in the engine", () => {
  it("passes time with a rest, and records why", () => {
    const short = run(started, organizer, { kind: "takeRest", rest: "short" });
    expect(short.state.world).toEqual({ day: 2, time: "night", weather: "rain" });
    expect(short.events.find((event) => event.kind === "worldChanged")).toMatchObject({ reason: "rest" });
    expect(run(started, organizer, { kind: "takeRest", rest: "long" }).state.world).toMatchObject({ day: 3, time: "dawn" });
  });

  it("keeps no clock for an adventure that gave none, whatever the story asks", () => {
    const none = newCampaign();
    expect(run(none, organizer, { kind: "takeRest", rest: "long" }).state.world).toBeUndefined();
  });

  it("lets the organizer correct it, with the reason kept in the history, and nobody else", () => {
    const fixed = run(started, organizer, { kind: "setWorld", time: "dawn", weather: null, note: "The Narrator said sunrise." });
    expect(fixed.state.world).toEqual({ day: 2, time: "dawn" });
    expect(fixed.events.find((event) => event.kind === "worldChanged")).toMatchObject({ reason: "correction", note: "The Narrator said sunrise." });
    expect(() => run(started, jamie, { kind: "setWorld", time: "dawn" })).toThrow(/notOrganizer/);
    expect(() => run(started, organizer, { kind: "setWorld", time: "teatime" as never })).toThrow(/invalidPlan/);
    expect(() => run(started, organizer, { kind: "setWorld", day: 0 })).toThrow(/invalidPlan/);
    // A correction can start a clock the adventure did not have.
    expect(run(newCampaign(), organizer, { kind: "setWorld", time: "night" }).state.world).toEqual({ day: 1, time: "night" });
  });

  it("moves with the story when a round's plan says time passes or the weather turns", () => {
    const closed = ((): typeof started => {
      let next = run({ ...newCampaign(), world: dusk }, system, { kind: "openRound" }).state;
      next = run(next, alex, { kind: "submitAction", characterId: "c-mira", text: "We wait out the night." }).state;
      return run(next, jamie, { kind: "pass", characterId: "c-borin" }).state as typeof started;
    })();
    const always = { kind: "always" } as const;
    const effects: PlannedEffect[] = [
      { effect: { kind: "advanceTime", steps: 2 }, when: always },
      { effect: { kind: "setWeather", weather: "clear" }, when: always },
    ];
    const proposal: RoundPlanProposal = { roundNumber: 1, actions: [{ characterId: "c-mira", resolution: { kind: "automatic", reason: "waits" } }], effects };
    const step = run(closed, system, { kind: "applyRoundPlan", proposal });
    expect(step.state.world).toEqual({ day: 3, time: "dawn", weather: "clear" });
    const wrong: RoundPlanProposal = { ...proposal, effects: [{ effect: { kind: "advanceTime", steps: 40 }, when: always }] };
    expect(() => run(closed, system, { kind: "applyRoundPlan", proposal: wrong })).toThrow(/invalidPlan/);
  });
});
