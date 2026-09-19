import type { MutationSettingDefinition } from "./setting-definition.js";

export const reactionRepliesSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "reaction-replies",
  description: "Lets the bot judge whether to reply to reactions on its own chat replies.",
  configureOptions: () => [
    { type: "boolean", name: "enabled", description: "Whether reaction replies are on." },
  ],
  handle: (context, _deps, _previousProfile, input) => {
    const enabled = context.interaction.options.getBoolean("enabled");
    if (enabled !== null) input.reactionReplies = enabled;
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [
    { label: "Reaction replies enabled", read: (p) => p.features.reactionReplies },
  ],
};
