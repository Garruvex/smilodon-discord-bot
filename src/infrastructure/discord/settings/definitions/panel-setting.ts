import { PANEL_LIMITS } from "../../../../config/guild-configuration-limits.js";
import type { MutationSettingDefinition } from "./setting-definition.js";
import { buildProgressBarSettings } from "./settings-support.js";

export const panelSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "panel",
  description: "Updates the music panel.",
  configureOptions: () => [
    { type: "channel", name: "channel", description: "Music control channel.", guildTextOnly: true, panel: { label: "Music panel channel", read: (p) => p.channels.controlPanel } },
    { type: "string", name: "idle-image-url", description: "Stable HTTPS idle image URL." },
    { type: "attachment", name: "idle-image", description: "Upload a persistent PNG, JPEG, WebP, or GIF idle image." },
    { type: "boolean", name: "use-default-image", description: "Use the bundled Smilodon idle image." },
    {
      type: "string", name: "progress-style", description: "Progress bar appearance.",
      panel: { label: "Progress bar", read: (p) => p.panel.progressBar.style },
      choices: [
        { name: "Standard", value: "standard" },
        { name: "Yohta", value: "yohta" },
        { name: "Custom", value: "custom" },
        { name: "Timestamps only", value: "none" },
      ],
    },
    {
      type: "integer", name: "progress-length", description: "Progress bar length.",
      panel: { label: "Progress bar length", read: (p) => p.panel.progressBar.length },
      minValue: PANEL_LIMITS.progressBarLength.min, maxValue: PANEL_LIMITS.progressBarLength.max,
    },
    { type: "string", name: "progress-completed", description: "Custom completed emoji; paste an emoji or enter its server name." },
    { type: "string", name: "progress-remaining", description: "Custom remaining emoji; paste an emoji or enter its server name." },
    { type: "string", name: "progress-playing", description: "Custom current-position emoji while playing." },
    { type: "string", name: "progress-paused", description: "Custom current-position emoji while paused." },
    { type: "string", name: "progress-ending", description: "Optional ending emoji, or 'none' to remove it." },
  ],
  handle: async (request, deps, previousProfile, input) => {
    const channel = request.values.getChannel("channel");
    const url = request.values.getString("idle-image-url");
    const attachment = request.values.getAttachment("idle-image");
    const useDefault = request.values.getBoolean("use-default-image");
    if (channel) input.controlPanelChannelId = channel.id;
    if (url) {
      input.idleImageUrl = url;
      input.idleImageAsset = null;
    }
    if (attachment) {
      input.idleImageAsset = await deps.assets.saveIdleImage(request.guildId, attachment);
      input.idleImageUrl = null;
    }
    if (useDefault === true) {
      input.idleImageUrl = null;
      input.idleImageAsset = null;
    }
    try {
      const progressBar = await buildProgressBarSettings(
        request.guild,
        request,
        previousProfile.panel.progressBar,
        deps.applicationEmojiCatalog,
      );
      if (progressBar) input.progressBar = progressBar;
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "The progress bar settings are invalid." };
    }
    return { ok: true };
  },
  describe: (previous, updated) => {
    if (
      previous.idleImageUrl !== updated.idleImageUrl ||
      previous.idleImageAsset !== updated.idleImageAsset ||
      previous.channels.controlPanel !== updated.channels.controlPanel ||
      previous.panel.progressBar.style !== updated.panel.progressBar.style ||
      previous.panel.progressBar.length !== updated.panel.progressBar.length ||
      previous.panel.progressBar.customTheme !== updated.panel.progressBar.customTheme
    ) {
      return "Panel settings updated. The control panel has been refreshed.";
    }
    return null;
  },
};
