import type { Texts } from "../../../application/i18n/texts.js";
import type { PanelView } from "../../../application/campaign/views/campaign-views.js";

// "Day 2 · dusk · rain", in the table's language; empty when the adventure keeps no clock.
export function worldLine(world: PanelView["world"], text: Texts): string {
  if (world === undefined) return "";
  const t = text.campaign.world;
  const time = t.time[world.time as keyof typeof t.time];
  const weather = world.weather === undefined ? "" : t.weather[world.weather as keyof typeof t.weather];
  return t.line({ day: world.day, time, weather: weather === "" ? "" : ` · ${weather}` });
}
