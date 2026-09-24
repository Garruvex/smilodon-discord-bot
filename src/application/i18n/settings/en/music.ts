import type { SettingsTextCatalog } from "../catalog.js";

export const enMusic: SettingsTextCatalog = {
  "music": { title: "Music", description: "Music panel and playback behavior." },

  "music.panel": {
    label: "Music panel",
    description: "Updates the music panel.",
    messages: { preview: "Preview:" },
  },
  "music.panel.channel": { label: "Panel channel", description: "Music control channel." },
  "music.panel.progress-style": {
    label: "Progress bar",
    description: "Progress bar appearance.",
    choices: { standard: "Standard", yohta: "Yohta", custom: "Custom", none: "Timestamps only" },
    messages: {
      "yohta-missing": "The Yohta preset is not provisioned for this bot application. Missing: {missing}.",
      "custom-missing": "Set the custom emojis with /settings-music progress-emojis before choosing custom.",
    },
  },
  "music.panel.progress-length": { label: "Progress bar length", description: "Progress bar length." },

  "music.idle-image": { label: "Idle image", description: "The image the music panel shows when nothing is playing." },
  "music.idle-image.file": { label: "Image file", description: "Upload a persistent PNG, JPEG, WebP, or GIF idle image." },
  "music.idle-image.url": {
    label: "Image URL",
    description: "Stable HTTPS idle image URL.",
    messages: { "not-https": "The idle image URL must start with https://." },
  },

  "music.default-idle-image": {
    label: "Use the default image",
    description: "Use the bundled Smilodon idle image.",
    messages: { done: "The idle image is back to the bundled default." },
  },

  "music.progress-emojis": {
    label: "Custom progress emojis",
    description: "Sets the custom progress bar's emojis and switches to it.",
    messages: {
      done: "Custom progress emojis saved; the progress bar now uses them.",
      "no-guild": "This only works in a server.",
    },
  },
  "music.progress-emojis.completed": {
    label: "Played part",
    description: "Custom completed emoji; paste an emoji or enter its server name.",
  },
  "music.progress-emojis.remaining": {
    label: "Unplayed part",
    description: "Custom remaining emoji; paste an emoji or enter its server name.",
  },
  "music.progress-emojis.playing": { label: "Position (playing)", description: "Custom current-position emoji while playing." },
  "music.progress-emojis.paused": { label: "Position (paused)", description: "Custom current-position emoji while paused." },
  "music.progress-emojis.ending": { label: "Ending", description: "Optional ending emoji, or 'none' to remove it." },

  "music.volume": { label: "Volume", description: "Updates music volume limits." },
  "music.volume.default": { label: "Default volume", description: "Default volume." },
  "music.volume.maximum": { label: "Maximum volume", description: "Maximum volume." },
  "music.volume.button-step": { label: "Volume button step", description: "Panel adjustment amount." },

  "music.lifecycle": { label: "Leaving and pausing", description: "Updates empty queue/channel behavior." },
  "music.lifecycle.empty-queue-action": {
    label: "When the queue ends",
    description: "Action when the queue ends.",
    choices: { disconnect: "Disconnect", stay_connected: "Stay connected" },
  },
  "music.lifecycle.queue-delay-seconds": { label: "Queue-end delay (seconds)", description: "Delay before empty-queue action." },
  "music.lifecycle.empty-channel-action": {
    label: "When everyone leaves",
    description: "Action when everyone leaves.",
    choices: { continue: "Keep playing", pause: "Pause", disconnect: "Disconnect" },
  },
  "music.lifecycle.channel-grace-seconds": { label: "Empty-channel grace (seconds)", description: "Grace period before action." },
  "music.lifecycle.resume-when-occupied": { label: "Resume when someone returns", description: "Resume after an automatic pause." },

  "music.dj-mode": { label: "DJ mode", description: "Lets music-controller roles control playback from anywhere." },
  "music.dj-mode.enabled": { label: "DJ mode", description: "Whether DJ mode is on." },

  "music.open-queue-requests": {
    label: "Open queue requests",
    description: "Lets anyone queue songs without joining the bot's voice channel.",
  },
  "music.open-queue-requests.enabled": { label: "Open queue requests", description: "Whether open queue requests are on." },

  "music.autoqueue-vote": { label: "Up-next vote", description: "Lets listeners vote on which song autoqueue plays next." },
  "music.autoqueue-vote.enabled": {
    label: "Up-next vote",
    description: "Whether listeners vote; off means autoqueue picks on its own.",
  },
  "music.autoqueue-vote.bar-style": {
    label: "Vote bar style",
    description: "How vote bars look.",
    choices: { squares: "Colored squares", thin: "Thin bar (matches the progress bar)" },
  },
  "music.autoqueue-vote.options": { label: "Songs to choose from", description: "How many songs to pick from." },
};
