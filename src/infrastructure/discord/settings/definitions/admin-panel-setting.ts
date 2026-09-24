import type { MutationSettingDefinition } from "./setting-definition.js";
import { formatChannelMention } from "./settings-support.js";

// Where the admin panel lives. Setting it posts the panel there (see
// AdminPanelService, which listens for this change); disabling removes it.
export const adminPanelSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "admin-panel",
  description: "Sets the channel for the admin settings panel.",
  configureOptions: () => [
    {
      type: "channel", name: "channel", guildTextOnly: true,
      description: "Text channel for the admin panel; keep it visible to bot admins only.",
    },
    { type: "boolean", name: "disable", description: "Remove the admin panel." },
  ],
  handle: (request, _deps, _previousProfile, input) => {
    const channel = request.values.getChannel("channel");
    const disable = request.values.getBoolean("disable");
    if (channel) input.adminPanelChannelId = channel.id;
    if (disable === true) input.adminPanelChannelId = null;
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [{ label: "Admin panel channel", read: (p) => formatChannelMention(p.channels.adminPanel) }],
};
