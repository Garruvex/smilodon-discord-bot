import { CHAT_LIMITS } from "../../../../../config/guild-configuration-limits.js";
import type { MutationSettingDefinition } from "./setting-definition.js";

export const channelHistorySetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "channel-history",
  description: "Controls whether the bot includes recent channel messages (from anyone) as ambient chat context.",
  configureOptions: () => [
    { type: "boolean", name: "enabled", description: "Whether ambient channel history is on." },
    {
      type: "integer", name: "limit", description: "How many recent channel messages to include.",
      minValue: CHAT_LIMITS.channelHistoryLimit.min, maxValue: CHAT_LIMITS.channelHistoryLimit.max,
    },
  ],
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
