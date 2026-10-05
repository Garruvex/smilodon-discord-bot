// The phases of a day and the kinds of weather a story can have. Shared by what an adventure may say (a start time, time passing,
// the sky turning) and by the world the engine keeps (state/world-state.ts).
export const timesOfDay = ["dawn", "morning", "midday", "afternoon", "dusk", "night"] as const;
export type TimeOfDay = (typeof timesOfDay)[number];

export const weathers = ["clear", "rain", "storm", "fog", "snow", "wind"] as const;
export type Weather = (typeof weathers)[number];

export function isTimeOfDay(value: string): value is TimeOfDay {
  return (timesOfDay as readonly string[]).includes(value);
}

export function isWeather(value: string): value is Weather {
  return (weathers as readonly string[]).includes(value);
}

// Where the story clock stands as one number: phases of the day since the first dawn. Null when the adventure keeps no clock.
export function worldPhase(world: { readonly day: number; readonly time: TimeOfDay } | undefined): number | null {
  return world === undefined ? null : (world.day - 1) * timesOfDay.length + timesOfDay.indexOf(world.time);
}

// SRD 5.1: a character can't benefit from more than one long rest in 24 hours. A day is every phase of the clock once round.
export function longRestTooSoon(world: { readonly day: number; readonly time: TimeOfDay } | undefined, lastLongRestAt: number | undefined): boolean {
  const now = worldPhase(world);
  return now !== null && lastLongRestAt !== undefined && now - lastLongRestAt < timesOfDay.length;
}
