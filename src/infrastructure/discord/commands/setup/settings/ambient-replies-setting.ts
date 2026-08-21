import { CHAT_LIMITS } from "../../../../../config/guild-configuration-limits.js";
import type { MutationSettingDefinition } from "./setting-definition.js";

export const ambientRepliesSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "ambient-replies",
  description: "Controls whether the bot may judge and react/reply to messages that name it without an @mention.",
  configureOptions: (b) => b
    .addBooleanOption((o) => o.setName("enabled").setDescription("Whether ambient replies are on."))
    .addIntegerOption((o) => o.setName("cooldown-seconds").setDescription("Minimum seconds between ambient judgment calls per channel.")
      .setMinValue(CHAT_LIMITS.ambientCooldownSeconds.min).setMaxValue(CHAT_LIMITS.ambientCooldownSeconds.max)),
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
