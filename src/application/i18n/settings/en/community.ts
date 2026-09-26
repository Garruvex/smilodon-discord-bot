import type { SettingsTextCatalog } from "../catalog.js";

export const enCommunity: SettingsTextCatalog = {
  "community": { title: "Community", description: "Standalone community features." },

  "community.language": { label: "Language", description: "Sets the language for translated bot messages in this server." },
  "community.language.language": {
    label: "Language",
    description: "The language to use.",
    // Each language by its own name, so every catalog shows the same.
    choices: { "en": "English", "zh-TW": "繁體中文", "ja": "日本語" },
  },

  "community.timezone": {
    label: "Time zone",
    description: "Sets the IANA time zone used for birthdays and other guild-local dates.",
  },
  "community.timezone.zone": {
    label: "Time zone",
    description: "An IANA time zone name, e.g. \"America/New_York\" or \"Asia/Taipei\".",
    messages: { unknown: "\"{zone}\" isn't a recognized IANA time zone name (e.g. \"America/New_York\")." },
  },

  "community.birthdays": {
    label: "Birthdays",
    description: "Configures automatic birthday announcements.",
    messages: { "needs-channel": "Set a birthday announcement channel before turning this on." },
  },
  "community.birthdays.enabled": { label: "Birthday announcements", description: "Turn birthday announcements on or off." },
  "community.birthdays.channel": {
    label: "Announcement channel",
    description: "Text channel where birthday announcements are posted.",
  },

  "community.reminders": { label: "Reminders", description: "Configures whether members can set personal reminders." },
  "community.reminders.enabled": { label: "Reminders", description: "Turn the /remind command on or off." },
  "community.campaign": { label: "D&D campaigns", description: "Configures whether the server can run AI-hosted D&D campaigns." },
  "community.campaign.enabled": { label: "D&D campaigns", description: "Turn the /dnd command on or off." },

  "community.welcome": { label: "Join and leave messages", description: "Sets join/leave announcement channels." },
  "community.welcome.join-channel": { label: "Welcome channel", description: "Where new-member welcome cards are posted. Empty turns them off." },
  "community.welcome.leave-channel": { label: "Leave channel", description: "Where member-left messages are posted. Empty turns them off." },

  "community.link-fix": {
    label: "Link fixing",
    description: "Configures automatic link previews for supported platforms.",
    messages: { "needs-channel": "Add at least one watched channel before turning this on." },
  },
  "community.link-fix.enabled": { label: "Link fixing", description: "Turn automatic link rewriting on or off." },
  "community.link-fix.channels": { label: "Watched channels", description: "Text channels watched for rewritable links." },
  "community.link-fix.twitter": { label: "Twitter/X", description: "Turn Twitter/X link fixing on or off." },
  "community.link-fix.threads": { label: "Threads", description: "Turn Threads link fixing on or off." },
  "community.link-fix.tiktok": { label: "TikTok", description: "Turn TikTok link fixing on or off." },
  "community.link-fix.instagram": { label: "Instagram", description: "Turn Instagram link fixing on or off." },
  "community.link-fix.reddit": { label: "Reddit", description: "Turn Reddit link fixing on or off." },
  "community.link-fix.bilibili": { label: "Bilibili", description: "Turn Bilibili link fixing on or off." },

  "community.nsfw": { label: "NSFW commands", description: "Turns NSFW image commands on or off for this server." },
  "community.nsfw.enabled": {
    label: "NSFW commands",
    description: "Allow NSFW image commands (still requires an age-restricted channel).",
  },

  "community.member-data": {
    label: "Member data",
    description: "Controls whether a departing member's data is kept or deleted.",
  },
  "community.member-data.retain": {
    label: "Keep departing members' data",
    description: "true: keep their data if they return. false: delete it when they leave.",
  },
};
