import { isValidTimeZone } from "../../../../../config/guild-configuration-schema.js";
import type { MutationSettingDefinition } from "./setting-definition.js";

export const timezoneSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "timezone",
  description: "Sets the IANA time zone birthdays (and other guild-local dates) are computed in. Defaults to UTC.",
  configureOptions: () => [
    { type: "string", name: "zone", description: "An IANA time zone name, e.g. \"America/New_York\" or \"Asia/Taipei\".", required: true },
  ],
  handle: (context, _deps, _previousProfile, input) => {
    const zone = context.interaction.options.getString("zone", true).trim();
    if (!isValidTimeZone(zone)) {
      return Promise.resolve({
        ok: false,
        message: `"${zone}" isn't a recognized IANA time zone name (e.g. "America/New_York").`,
      });
    }
    input.timezone = zone;
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [{ label: "Time zone", read: (p) => p.timezone }],
};
