import type { SettingsTextCatalog } from "../catalog.js";

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
      "no-log": "ℹ️ No log channel (or audit-log channel) is set, so actions aren't reported.",
      "log": "✅ Reports go to {channel}.",
      "log-unavailable": "⚠️ I can't send to the log channel.",
    },
  },
};
