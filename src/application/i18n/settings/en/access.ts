import type { SettingsTextCatalog } from "../catalog.js";

export const enAccess: SettingsTextCatalog = {
  "access": { title: "Access", description: "Roles, permissions, and audit logging." },

  "access.roles": {
    label: "Access roles",
    description: "Which roles can manage settings, control music, use AI chat, or are restricted.",
  },
  "access.roles.administrator": {
    label: "Bot administrators",
    description: "Manage server settings and inherit every music-controller permission.",
    messages: { required: "At least one bot-administrator role must remain configured." },
  },
  "access.roles.music-controller": {
    label: "Music controllers",
    description: "Use /play, queue commands, panel controls, and typed song requests.",
    messages: { required: "Music is enabled, so at least one music-controller role must remain configured." },
  },
  "access.roles.chatbot": {
    label: "AI chat",
    description: "Can mention the bot for AI chat when the chatbot feature is on.",
    messages: { required: "The chatbot is enabled, so at least one chatbot role must remain configured (or turn the chatbot feature off first)." },
  },
  "access.roles.restricted": {
    label: "Restricted",
    description: "Denied music and chatbot features unless a bot-owner bypass applies.",
  },

  "access.admin-panel": {
    label: "Admin panel",
    description: "Where this settings panel lives. Keep the channel visible to bot admins only.",
  },
  "access.admin-panel.channel": { label: "Panel channel", description: "Text channel for the admin settings panel." },

  "access.repair-panel": {
    label: "Repair the panel",
    description: "Take this panel down and post it again, in order.",
    messages: {
      "done": "The admin panel has been posted again.",
      "no-panel": "There's no admin panel channel set.",
    },
  },

  "access.audit-log": { label: "Audit log", description: "Where settings and setup changes are logged." },
  "access.audit-log.channel": { label: "Audit log channel", description: "Text channel that receives audit log entries." },

  "access.access": { label: "Access summary", description: "Who holds each access group and what the group allows." },

  "access.audit": {
    label: "Recent changes",
    description: "Recent settings and setup changes from the audit log.",
    messages: {
      "unavailable": "Audit logging isn't available right now.",
      "not-configured": "No audit log channel is set. Set one with `/settings-access audit-log channel:<channel>`.",
      "empty": "No audit log entries yet.",
      "heading": "Recent audit log entries:",
    },
  },
  "access.audit.count": { label: "Entries", description: "How many recent entries to show (default 10)." },
};
