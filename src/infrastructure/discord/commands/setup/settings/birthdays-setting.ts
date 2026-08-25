import type { MutationSettingDefinition } from "./setting-definition.js";
import { formatChannelMention } from "./settings-support.js";

export const birthdaysSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "birthdays",
  description: "Configures automatic birthday announcements.",
  configureOptions: () => [
    { type: "boolean", name: "enabled", description: "Turn birthday announcements on or off." },
    { type: "channel", name: "channel", description: "Text channel where birthday announcements are posted.", guildTextOnly: true },
  ],
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
    { label: "Birthday announcements channel", read: (p) => formatChannelMention(p.channels.birthdayAnnouncements) },
  ],
};
