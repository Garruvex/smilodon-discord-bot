import type { MutationSettingDefinition } from "./setting-definition.js";

export const channelHistorySetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "channel-history",
  description: "Controls whether the bot includes recent channel messages (from anyone) as ambient chat context.",
  configureOptions: (b) => b
    .addBooleanOption((o) => o.setName("enabled").setDescription("Whether ambient channel history is on."))
    .addIntegerOption((o) => o.setName("limit").setDescription("How many recent channel messages to include.").setMinValue(1).setMaxValue(25)),
  handle: (context, _deps, _previousProfile, input) => {
    const enabled = context.interaction.options.getBoolean("enabled");
    const limit = context.interaction.options.getInteger("limit");
    if (enabled !== null) input.channelHistory = enabled;
    if (limit !== null) input.channelHistoryLimit = limit;
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [
    { label: "Channel history enabled", read: (p) => p.features.channelHistory },
    { label: "Channel history limit", read: (p) => p.chat.channelHistoryLimit },
  ],
};
