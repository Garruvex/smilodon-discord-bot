import { ChannelType } from "discord.js";

import type { MutationSettingDefinition } from "./setting-definition.js";

export const birthdaysSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "birthdays",
  description: "Configures automatic birthday announcements.",
  configureOptions: (b) => b
    .addBooleanOption((o) => o.setName("enabled").setDescription("Turn birthday announcements on or off."))
    .addChannelOption((o) => o.setName("channel").setDescription("Text channel where birthday announcements are posted.").addChannelTypes(ChannelType.GuildText)),
  handle: (context, _deps, previousProfile, input) => {
    const enabled = context.interaction.options.getBoolean("enabled");
    const channel = context.interaction.options.getChannel("channel");
    if (channel) input.birthdayAnnouncementsChannelId = channel.id;
    if (enabled !== null) input.birthdaysEnabled = enabled;
    const nextEnabled = enabled ?? previousProfile.features.birthdays;
    const nextChannel = channel?.id ?? previousProfile.channels.birthdayAnnouncements;
    if (nextEnabled && !nextChannel) {
      return Promise.resolve({
        ok: false,
        message: "Set a birthday-announcements channel with `channel:<channel>` before enabling this feature.",
      });
    }
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [
    { label: "Birthdays enabled", read: (p) => p.features.birthdays },
    { label: "Birthday announcements channel", read: (p) => p.channels.birthdayAnnouncements },
  ],
};
