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
      notSetUp: "**Not set up yet.** Pick a hub channel below (or run /dnd setup in the channel you want).",
      none: "not set",
      hub: "Hub channel: {channel}",
      role: "DnD Admin role: {role}",
      games: "Games not finished: {count}",
      modelReady: "AI dungeon master: ready.",
      modelMissing: "AI dungeon master: **not configured** on this bot (CAMPAIGN_MODEL), so games cannot start.",
    },
  },

  "dnd.hub-channel": {
    label: "Hub channel",
    description: "Sets up the D&D category and puts the games hub, with its Create game button, in this channel.",
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
      notSetUp: "Set up the hub first (Hub channel), then pick a role.",
      done: "Members of {role} can now create and manage games.",
    },
  },
  "dnd.admin-role.role": { label: "Role", description: "The role that runs D&D on this server." },

  "dnd.repair": {
    label: "Repair D&D",
    description: "Checks the category, hub, DnD Admin role and every game's cards, and makes what is missing again.",
    messages: {
      unavailable: "D&D is not available on this bot.",
      permissions: "The bot is missing permissions it needs for D&D: {missing}.",
      done: "D&D was checked and anything missing was made again.",
    },
  },
};
