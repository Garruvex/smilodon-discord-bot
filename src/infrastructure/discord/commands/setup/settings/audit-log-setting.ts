import type { MutationSettingDefinition } from "./setting-definition.js";
import { formatChannelMention } from "./settings-support.js";

export const auditLogSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "audit-log",
  description: "Configures the channel that receives settings/setup change logs.",
  configureOptions: () => [
    { type: "channel", name: "channel", description: "Text channel to receive audit log entries.", guildTextOnly: true },
    { type: "boolean", name: "disable", description: "Stop sending audit log entries." },
  ],
  handle: (context, _deps, _previousProfile, input) => {
    const channel = context.interaction.options.getChannel("channel");
    const disable = context.interaction.options.getBoolean("disable");
    if (channel) input.auditLogChannelId = channel.id;
    if (disable === true) input.auditLogChannelId = null;
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [{ label: "Audit log channel", read: (p) => formatChannelMention(p.channels.auditLog) }],
};
