import { languages } from "../../../../application/i18n/language.js";
import type { LinkFixPlatform } from "../../../../config/guild-configuration.js";
import { isValidTimeZone } from "../../../../config/guild-configuration-schema.js";
import { channel, channelList, choice, group, setting, text, toggle } from "../registry/builders.js";
import type { ToggleOption } from "../registry/types.js";

const linkFixPlatforms: readonly LinkFixPlatform[] = ["twitter", "threads", "tiktok", "instagram", "reddit", "bilibili"];

const platformToggle = (platform: LinkFixPlatform): ToggleOption => toggle({
  read: (p) => p.linkFixPlatforms[platform],
  write: (v) => ({ linkFixPlatformOverrides: { [platform]: v } }),
});

export const community = group("community", [
  setting("language", {
    language: choice({
      required: true,
      choices: languages,
      read: (p) => p.language,
      write: (v) => ({ language: v }),
    }),
  }, { setup: true }),

  setting("timezone", {
    zone: text({
      required: true,
      maxLength: 64,
      read: (p) => p.timezone,
      write: (v) => ({ timezone: v.trim() }),
      validate: (v, context) => (isValidTimeZone(v.trim()) ? null : context.error("unknown", { zone: v.trim() })),
    }),
  }, { setup: true }),

  setting("birthdays", {
    enabled: toggle({ read: (p) => p.features.birthdays, write: (v) => ({ birthdaysEnabled: v }) }),
    channel: channel({
      textOnly: true,
      read: (p) => p.channels.birthdayAnnouncements,
      write: (v) => ({ birthdayAnnouncementsChannelId: v }),
    }),
  }, {
    setup: true,
    validate: (patch, context) => {
      const enabled = patch.birthdaysEnabled ?? context.profile.features.birthdays;
      const channelId = patch.birthdayAnnouncementsChannelId ?? context.profile.channels.birthdayAnnouncements;
      return enabled && !channelId ? context.error("needs-channel") : null;
    },
  }),

  setting("reminders", {
    enabled: toggle({ read: (p) => p.features.reminders, write: (v) => ({ remindersEnabled: v }) }),
  }, { setup: true }),

  setting("welcome", {
    "join-channel": channel({
      textOnly: true,
      clearable: true,
      read: (p) => p.channels.joinAnnouncements,
      write: (v) => ({ joinAnnouncementsChannelId: v }),
    }),
    "leave-channel": channel({
      textOnly: true,
      clearable: true,
      read: (p) => p.channels.leaveAnnouncements,
      write: (v) => ({ leaveAnnouncementsChannelId: v }),
    }),
  }, { setup: true }),

  setting("link-fix", {
    enabled: toggle({ read: (p) => p.features.linkFix, write: (v) => ({ linkFixEnabled: v }) }),
    channels: channelList({
      textOnly: true,
      read: (p) => [...p.channels.linkFix],
      write: (v) => ({ linkFixChannelIds: v }),
    }),
    ...Object.fromEntries(linkFixPlatforms.map((platform) => [platform, platformToggle(platform)])),
  }, {
    validate: (patch, context) => {
      const enabled = patch.linkFixEnabled ?? context.profile.features.linkFix;
      const channelCount = patch.linkFixChannelIds?.length ?? context.profile.channels.linkFix.size;
      return enabled && channelCount === 0 ? context.error("needs-channel") : null;
    },
  }),

  setting("nsfw", {
    enabled: toggle({ required: true, read: (p) => p.features.nsfw, write: (v) => ({ nsfwEnabled: v }) }),
  }),

  setting("member-data", {
    retain: toggle({
      required: true,
      read: (p) => p.features.retainMemberDataOnLeave,
      write: (v) => ({ retainMemberDataOnLeave: v }),
    }),
  }),
]);
