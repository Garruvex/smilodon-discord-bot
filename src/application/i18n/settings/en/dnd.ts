import type { SettingsTextCatalog } from "../catalog.js";

export const enDnd: SettingsTextCatalog = {
  "dnd": { title: "D&D", description: "AI-hosted D&D campaigns: the switch, where games are shown, and who runs them." },

  "dnd.campaigns": { label: "D&D campaigns", description: "Whether this server can run AI-hosted D&D campaigns." },
  "dnd.campaigns.enabled": { label: "D&D campaigns", description: "Turn the /dnd command and the games hub on or off." },

  "dnd.status": {
    description: "Shows the games hub, the DnD Admin role and how many games are running.",
    messages: {
      unavailable: "D&D is not available on this bot.",
      setUp: "**Set up.** Games are shown in the hub.",
      notSetUp: "**Not set up yet.** Use **Set up D&D** below: it makes a D&D category with a #dnd-games hub.",
      none: "not set",
      hub: "Hub channel: {channel}",
      role: "DnD Admin role: {role}",
      games: "Games not finished: {count}",
      modelReady: "AI dungeon master: ready.",
      modelMissing: "AI dungeon master: **not configured** on this bot (CAMPAIGN_MODEL), so games cannot start.",
    },
  },

  "dnd.setup": {
    label: "Set up D&D",
    description: "Makes the D&D category with a #dnd-games hub and the DnD Admin role, or checks and repairs them.",
    messages: {
      unavailable: "D&D is not available on this bot.",
      permissions: "The bot is missing permissions it needs for D&D: {missing}.",
      done: "D&D is set up. The games hub is {channel}; anything missing was made again.",
    },
  },

  "dnd.hub-channel": {
    label: "Move the hub",
    description: "Puts the games hub, with its Create game button, in a channel you pick instead of #dnd-games.",
    messages: {
      unavailable: "D&D is not available on this bot.",
      permissions: "The bot is missing permissions it needs for D&D: {missing}.",
      done: "The games hub is now in {channel}. Its control message and every game's message were posted there.",
    },
  },
  "dnd.hub-channel.channel": { label: "Channel", description: "The text channel for the hub. Members see it read-only." },

  "dnd.admin-role": {
    label: "DnD Admin role",
    description: "Picks the role whose members can create and manage every game.",
    messages: {
      unavailable: "D&D is not available on this bot.",
      notSetUp: "Set up D&D first, then pick a role.",
      done: "Members of {role} can now create and manage games.",
    },
  },
  "dnd.admin-role.role": { label: "Role", description: "The role that runs D&D on this server." },

};
