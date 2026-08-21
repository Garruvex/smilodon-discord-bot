import { ChannelType } from "discord.js";

import { PANEL_LIMITS } from "../../../../../config/guild-configuration-limits.js";
import type { MutationSettingDefinition } from "./setting-definition.js";
import { buildProgressBarSettings } from "./settings-support.js";

export const panelSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "panel",
  description: "Updates the music panel.",
  configureOptions: (b) => b
    .addChannelOption((o) => o.setName("channel").setDescription("Music control channel.").addChannelTypes(ChannelType.GuildText))
    .addStringOption((o) => o.setName("idle-image-url").setDescription("Stable HTTPS idle image URL."))
    .addAttachmentOption((o) => o.setName("idle-image").setDescription("Upload a persistent PNG, JPEG, WebP, or GIF idle image."))
    .addBooleanOption((o) => o.setName("use-default-image").setDescription("Use the bundled Smilodon idle image."))
    .addStringOption((o) => o.setName("progress-style").setDescription("Progress bar appearance.").addChoices(
      { name: "Standard", value: "standard" },
      { name: "Yohta", value: "yohta" },
      { name: "Custom", value: "custom" },
      { name: "Timestamps only", value: "none" },
    ))
    .addIntegerOption((o) => o.setName("progress-length").setDescription("Progress bar length.")
      .setMinValue(PANEL_LIMITS.progressBarLength.min).setMaxValue(PANEL_LIMITS.progressBarLength.max))
    .addStringOption((o) => o.setName("progress-completed").setDescription("Custom completed emoji; paste an emoji or enter its server name."))
    .addStringOption((o) => o.setName("progress-remaining").setDescription("Custom remaining emoji; paste an emoji or enter its server name."))
    .addStringOption((o) => o.setName("progress-playing").setDescription("Custom current-position emoji while playing."))
    .addStringOption((o) => o.setName("progress-paused").setDescription("Custom current-position emoji while paused."))
    .addStringOption((o) => o.setName("progress-ending").setDescription("Optional ending emoji, or 'none' to remove it.")),
  handle: async (context, deps, previousProfile, input) => {
    const channel = context.interaction.options.getChannel("channel");
    const url = context.interaction.options.getString("idle-image-url");
    const attachment = context.interaction.options.getAttachment("idle-image");
    const useDefault = context.interaction.options.getBoolean("use-default-image");
    if (channel) input.controlPanelChannelId = channel.id;
    if (url) {
      input.idleImageUrl = url;
      input.idleImageAsset = null;
    }
    if (attachment) {
      input.idleImageAsset = await deps.assets.saveIdleImage(context.interaction.guildId!, attachment);
      input.idleImageUrl = null;
    }
    if (useDefault === true) {
      input.idleImageUrl = null;
      input.idleImageAsset = null;
    }
    try {
      const progressBar = await buildProgressBarSettings(
        context.interaction.guild,
        context,
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
