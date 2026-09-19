import type { MutationSettingDefinition } from "./setting-definition.js";

export const historyReactionsSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "history-reactions",
  description: "Controls whether the bot may also react to other people's messages it already sees in channel history, piggybacked on turns it's already running.",
  configureOptions: () => [
    { type: "boolean", name: "enabled", description: "Whether history reactions are on." },
  ],
  handle: (context, _deps, _previousProfile, input) => {
    const enabled = context.interaction.options.getBoolean("enabled");
    if (enabled !== null) input.historyReactions = enabled;
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [
    { label: "History reactions enabled", read: (p) => p.features.historyReactions },
  ],
};
