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
