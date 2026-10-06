// The story's own clock and sky: which day it is and roughly when, and the weather. It moves only when the story says so
// (a scene's authored time passing, a rest, an organizer's correction), never with the wall clock or how long the table waited.
// An adventure that gives no start time has none: nobody invents one.
import { timesOfDay, type TimeOfDay, type Weather } from "../rules/world-rules.js";

export { isTimeOfDay, isWeather, timesOfDay, weathers, type TimeOfDay, type Weather } from "../rules/world-rules.js";

export interface WorldState {
  // Day 1 is the first day of the adventure.
  readonly day: number;
  readonly time: TimeOfDay;
  readonly weather?: Weather;
}

// What can happen to the world: time passes by phases of the day, a rest passes it, the sky changes, or the organizer sets it.
export type WorldChange =
  | { readonly kind: "advance"; readonly steps: number }
  // A short rest is one phase; a long rest carries on to the next dawn.
  | { readonly kind: "rest"; readonly rest: "short" | "long" }
  | { readonly kind: "weather"; readonly weather: Weather | null }
  | { readonly kind: "set"; readonly day?: number; readonly time?: TimeOfDay; readonly weather?: Weather | null };

export const maxDay = 10_000;

// The world after a change; null when it changes nothing.
export function changedWorld(world: WorldState, change: WorldChange): WorldState | null {
  let next: WorldState;
  switch (change.kind) {
    case "advance": {
      const at = timesOfDay.indexOf(world.time) + change.steps;
      next = { ...world, day: Math.min(maxDay, world.day + Math.floor(at / timesOfDay.length)), time: timesOfDay[at % timesOfDay.length] ?? world.time };
      break;
    }
    case "rest":
      if (change.rest === "short") return changedWorld(world, { kind: "advance", steps: 1 });
      next = { ...world, day: Math.min(maxDay, world.day + 1), time: "dawn" };
      break;
    case "weather": {
      const { weather: _old, ...rest } = world;
      next = change.weather === null ? rest : { ...rest, weather: change.weather };
      break;
    }
    case "set": {
      const { weather: oldWeather, ...rest } = world;
      const weather = change.weather === undefined ? oldWeather : (change.weather ?? undefined);
      next = { ...rest, day: Math.min(maxDay, Math.max(1, change.day ?? world.day)), time: change.time ?? world.time, ...(weather === undefined ? {} : { weather }) };
      break;
    }
  }
  return next.day === world.day && next.time === world.time && next.weather === world.weather ? null : next;
}
