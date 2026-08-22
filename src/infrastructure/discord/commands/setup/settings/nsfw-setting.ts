import type { MutationSettingDefinition } from "./setting-definition.js";

export const nsfwSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "nsfw",
  description: "Turns NSFW image commands on or off for this server.",
  configureOptions: () => [
    { type: "boolean", name: "enabled", description: "Allow NSFW image commands (still requires an age-restricted channel).", required: true },
  ],
  handle: (context, _deps, _previousProfile, input) => {
    input.nsfwEnabled = context.interaction.options.getBoolean("enabled", true);
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [{ label: "NSFW commands enabled", read: (p) => p.features.nsfw }],
};
