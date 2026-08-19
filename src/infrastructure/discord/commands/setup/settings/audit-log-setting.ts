import { ChannelType } from "discord.js";

import type { MutationSettingDefinition } from "./setting-definition.js";

export const auditLogSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "audit-log",
  description: "Configures the channel that receives settings/setup change logs.",
  configureOptions: (b) => b
    .addChannelOption((o) => o.setName("channel").setDescription("Text channel to receive audit log entries.").addChannelTypes(ChannelType.GuildText))
    .addBooleanOption((o) => o.setName("disable").setDescription("Stop sending audit log entries.")),
  handle: (context, _deps, _previousProfile, input) => {
    const channel = context.interaction.options.getChannel("channel");
    const disable = context.interaction.options.getBoolean("disable");
    if (channel) input.auditLogChannelId = channel.id;
    if (disable === true) input.auditLogChannelId = null;
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [{ label: "Audit log channel", read: (p) => p.channels.auditLog }],
};
