import type { SettingsTextCatalog } from "../catalog.js";

const windows = { "10s": "10 seconds", "30s": "30 seconds", "1m": "1 minute", "5m": "5 minutes" };
const actions = { timeout: "Time out", kick: "Kick", ban: "Ban" };
const deleteWindows = { "off": "Off", "10m": "Last 10 minutes", "30m": "Last 30 minutes", "1h": "Last hour" };
const timeouts = { "1h": "1 hour", "1d": "1 day", "7d": "7 days", "28d": "28 days" };

export const enSecurity: SettingsTextCatalog = {
  "security": { title: "Security", description: "Catch hacked accounts and spam bots automatically." },

  "security.trap": {
    label: "Trap channel",
    description: "A channel nobody should post in. Whoever does is actioned automatically.",
    messages: { "needs-channel": "Set a channel (or use create-channel) before turning this on." },
  },
  "security.trap.enabled": { label: "Trap channel", description: "Turn the trap channel on or off." },
  "security.trap.channel": { label: "Channel", description: "The channel to watch. Use create-channel or use-channel to also post the notice." },
  "security.trap.action": {
    label: "Action",
    description: "What happens to whoever posts there.",
    choices: { timeout: "Time out", kick: "Kick", ban: "Ban" },
  },
  "security.trap.delete-history": {
    label: "Delete their recent messages",
    description: "How far back to remove the poster's other messages. Off removes only the one in the channel.",
    choices: { "off": "Off", "10m": "Last 10 minutes", "30m": "Last 30 minutes", "1h": "Last hour" },
  },
  "security.trap.timeout-duration": {
    label: "Time-out length",
    description: "How long a time-out lasts, when the action is Time out.",
    choices: { "1h": "1 hour", "1d": "1 day", "7d": "7 days", "28d": "28 days" },
  },

  "security.spam": {
    label: "Cross-channel spam",
    description: "Catches the same message posted in several channels in moments.",
  },
  "security.spam.enabled": { label: "Cross-channel spam", description: "Turn spam detection on or off." },
  "security.spam.channels": { label: "Channels", description: "How many different channels the same message must reach (2-10)." },
  "security.spam.window": { label: "Within", description: "How quickly that has to happen.", choices: windows },
  "security.spam.action": {
    label: "Action",
    description: "What happens to whoever does it. Log only just reports it, to try this out safely.",
    choices: { report: "Log only", ...actions },
  },
  "security.spam.delete-history": {
    label: "Delete their recent messages",
    description: "How far back to remove their other messages, besides the repeated one.",
    choices: deleteWindows,
  },
  "security.spam.timeout-duration": { label: "Time-out length", description: "How long a time-out lasts.", choices: timeouts },

  "security.links": {
    label: "Link inspection",
    description: "Removes messages with blocked sites, lookalike addresses or other servers' invites.",
  },
  "security.links.enabled": { label: "Link inspection", description: "Turn link inspection on or off." },
  "security.links.action": {
    label: "Action",
    description: "What happens to whoever posts one. Log only changes nothing; Delete removes just the message.",
    choices: { report: "Log only", delete: "Delete the message", ...actions },
  },
  "security.links.delete-history": {
    label: "Delete their recent messages",
    description: "With an action beyond Delete: how far back to remove their other messages.",
    choices: deleteWindows,
  },
  "security.links.timeout-duration": { label: "Time-out length", description: "How long a time-out lasts.", choices: timeouts },
  "security.links.blocked-domains": {
    label: "Blocked sites",
    description: "Sites to always refuse, separated by commas or spaces. Type none to empty the list.",
    messages: {
      "invalid": "\"{entry}\" isn't a site name. Use names like example.com.",
      "too-many": "That's too many sites. The most is {max}.",
    },
  },
  "security.links.allowed-domains": {
    label: "Allowed sites",
    description: "Sites never refused, even if they look suspicious. Type none to empty the list.",
    messages: {
      "invalid": "\"{entry}\" isn't a site name. Use names like example.com.",
      "too-many": "That's too many sites. The most is {max}.",
    },
  },
  "security.links.suspicious": {
    label: "Suspicious addresses",
    description: "Also refuse fake-brand lookalikes, mixed-alphabet addresses and raw IP links.",
  },
  "security.links.invites": { label: "Other servers' invites", description: "Also refuse invites to other Discord servers." },

  "security.raid": {
    label: "Raid protection",
    description: "Notices many accounts joining at once, and can deal with them.",
  },
  "security.raid.enabled": { label: "Raid protection", description: "Turn raid protection on or off." },
  "security.raid.joins": { label: "Joins", description: "How many joins within the window count as a raid (3-50)." },
  "security.raid.window": { label: "Within", description: "How short that period is.", choices: windows },
  "security.raid.action": {
    label: "Action",
    description: "What happens to the joiners. Alert only tells staff.",
    choices: { alert: "Alert only", ...actions },
  },
  "security.raid.account-age-days": {
    label: "Only accounts newer than (days)",
    description: "Only act on accounts younger than this many days. 0 acts on every joiner (0-30).",
  },
  "security.raid.timeout-duration": { label: "Time-out length", description: "How long a time-out lasts.", choices: timeouts },

  "security.create-channel": {
    label: "Create trap channel",
    description: "Makes a channel with an ordinary name and posts the notice in every language.",
    messages: {
      "no-guild": "This server isn't loaded yet. Try again in a moment.",
      "missing-permission": "I need the Manage Channels permission to create a channel.",
      "failed": "I couldn't create the channel. Check my permissions and try again.",
      "done": "Created {channel} and posted the notice. Turn the trap channel on when you're ready.",
    },
  },
  "security.use-channel": {
    label: "Use an existing channel",
    description: "Uses a channel you already have and posts the notice in every language.",
    messages: {
      "missing": "Choose a channel.",
      "not-text": "Choose a regular text channel.",
      "no-access": "I need to see, send and manage messages in {channel}.",
      "failed": "I couldn't post the notice in {channel}.",
      "done": "Now using {channel} and posted the notice. Turn the trap channel on when you're ready.",
    },
  },
  "security.use-channel.channel": { label: "Channel", description: "The text channel to use as the trap." },

  "security.exempt": {
    label: "Exempt roles",
    description: "Roles that are never actioned. The owner, bot admins and staff are always exempt.",
  },
  "security.exempt.roles": { label: "Exempt roles", description: "Roles to leave alone." },

  "security.log": { label: "Security log", description: "Where security actions are reported. Unset uses the audit-log channel." },
  "security.log.channel": { label: "Log channel", description: "Text channel for security reports." },

  "security.status": {
    description: "Checks that the trap channel can work.",
    messages: {
      "heading": "**Security status**",
      "no-guild": "This server isn't loaded yet. Try again in a moment.",
      "on": "✅ The trap channel is on.",
      "off": "ℹ️ The trap channel is off.",
      "no-channel": "⚠️ No channel is set.",
      "channel-missing": "⚠️ The trap channel no longer exists. Set it up again.",
      "channel": "✅ Watching {channel}.",
      "everyone-cannot-post": "⚠️ Members can't post in {channel}, so it will catch nothing. Let everyone view and send there.",
      "bot-no-access": "⚠️ I can't see or manage messages in {channel}.",
      "missing-permission": "⚠️ I'm missing the {permission} permission that \"{action}\" needs.",
      "missing-sweep-permission": "⚠️ I'm missing Manage Messages, so I can't remove the poster's other messages.",
      "spam-missing-delete": "⚠️ I'm missing Manage Messages, so I can't remove spam posts.",
      "links-missing-delete": "⚠️ I'm missing Manage Messages, so I can't remove messages with refused links.",
      "no-log": "ℹ️ No log channel (or audit-log channel) is set, so actions aren't reported.",
      "log": "✅ Reports go to {channel}.",
      "log-unavailable": "⚠️ I can't send to the log channel.",
    },
  },
};
