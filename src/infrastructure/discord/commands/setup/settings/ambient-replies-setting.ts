import { CHAT_LIMITS } from "../../../../../config/guild-configuration-limits.js";
import type { MutationSettingDefinition } from "./setting-definition.js";

export const ambientRepliesSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "ambient-replies",
  description: "Controls whether the bot may judge and react/reply to messages that name it without an @mention.",
  configureOptions: () => [
    { type: "boolean", name: "enabled", description: "Whether ambient replies are on." },
    {
      type: "integer", name: "cooldown-seconds", description: "Minimum seconds between ambient judgment calls per channel.",
      minValue: CHAT_LIMITS.ambientCooldownSeconds.min, maxValue: CHAT_LIMITS.ambientCooldownSeconds.max,
    },
  ],
  handle: (context, _deps, _previousProfile, input) => {
    const enabled = context.interaction.options.getBoolean("enabled");
    const cooldownSeconds = context.interaction.options.getInteger("cooldown-seconds");
    if (enabled !== null) input.ambientReplies = enabled;
    if (cooldownSeconds !== null) input.ambientCooldownSeconds = cooldownSeconds;
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [
    { label: "Ambient replies enabled", read: (p) => p.features.ambientReplies },
    { label: "Ambient cooldown (seconds)", read: (p) => p.chat.ambientCooldownSeconds },
  ],
};
