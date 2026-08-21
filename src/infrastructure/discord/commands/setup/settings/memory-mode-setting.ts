import { ChannelType } from "discord.js";

import type { MutationSettingDefinition } from "./setting-definition.js";

const memoryModeChoices = [
  { name: "shared — durable memory writes normally, scoped by the model", value: "shared" },
  { name: "isolated — everything durable stays sealed to this channel, regardless of what the model claims", value: "isolated" },
  { name: "session_only — short-term reply context only, nothing durable is written", value: "session_only" },
  { name: "disabled — no memory reads or writes at all in this channel", value: "disabled" },
] as const;

// Enforces the isolation fix described in the memory-engine plan: the
// model's own channelScoped flag is only ever advisory (see
// memory-channel-policy.ts's resolveMemoryScope) — this setting is what
// actually determines whether a channel's memory writes can ever become
// guild-wide.
export const memoryModeSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "memory-mode",
  description: "Sets a channel's memory isolation mode (shared/isolated/session_only/disabled).",
  configureOptions: (b) => b
    .addChannelOption((o) => o.setName("channel").setDescription("The channel to configure.").setRequired(true).addChannelTypes(ChannelType.GuildText))
    .addStringOption((o) => o.setName("mode").setDescription("The memory mode for this channel.").setRequired(true)
      .addChoices(...memoryModeChoices)),
  handle: (context, _deps, previousProfile, input) => {
    const channel = context.interaction.options.getChannel("channel", true);
    const mode = context.interaction.options.getString("mode", true) as (typeof memoryModeChoices)[number]["value"];
    input.chatbotChannelMemoryModes = { ...previousProfile.chat.channelMemoryModes, [channel.id]: mode };
    return Promise.resolve({ ok: true });
  },
  describe: (_previous, updated, input) => {
    const channelId = Object.keys(input.chatbotChannelMemoryModes ?? {})[0];
    const mode = channelId ? updated.chat.channelMemoryModes[channelId] : null;
    return channelId && mode ? `<#${channelId}> memory mode set to \`${mode}\`.` : null;
  },
};
