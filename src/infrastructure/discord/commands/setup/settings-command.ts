import { ChannelType, SlashCommandBuilder, type Guild, type GuildEmoji } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import {
  formatRoleGroupList,
  roleGroupDescriptions,
} from "../../../../application/access/role-group-descriptions.js";
import type { UpdateGuildConfigurationInput, GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../../../../config/guild-configuration.js";
import { RoleMatchMode, publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import type { GuildAssetStore } from "../../../../application/assets/guild-asset-store.js";
import type { ControlChannelService } from "../../../../application/control-panel/control-channel-service.js";
import { renderProgressBar } from "../../../../application/control-panel/progress-bar-renderer.js";
import type {
  CustomProgressBarTheme,
  ProgressBarEmojiReference,
  ProgressBarSettings,
  ProgressBarStyle,
} from "../../../../config/guild-configuration.js";
import type { ApplicationEmojiCatalog } from "../../application-emoji-catalog.js";
import type { AuditLogService } from "../../../../application/audit/audit-log-service.js";

export class SettingsCommand implements BotCommand {
  private controlChannelService: ControlChannelService | null = null;

  public readonly definition = new SlashCommandBuilder()
    .setName("settings")
    .setDescription("Updates this server's bot configuration.")
    .addSubcommand((command) => command.setName("panel").setDescription("Updates the music panel.")
      .addChannelOption((option) => option.setName("channel").setDescription("Music control channel.").addChannelTypes(ChannelType.GuildText))
      .addStringOption((option) => option.setName("idle-image-url").setDescription("Stable HTTPS idle image URL."))
      .addAttachmentOption((option) => option.setName("idle-image").setDescription("Upload a persistent PNG, JPEG, WebP, or GIF idle image."))
      .addBooleanOption((option) => option.setName("use-default-image").setDescription("Use the bundled Smilodon idle image."))
      .addStringOption((option) => option.setName("progress-style").setDescription("Progress bar appearance.").addChoices(
        { name: "Standard", value: "standard" },
        { name: "Yohta", value: "yohta" },
        { name: "Custom", value: "custom" },
        { name: "Timestamps only", value: "none" },
      ))
      .addIntegerOption((option) => option.setName("progress-length").setDescription("Progress bar length.").setMinValue(6).setMaxValue(16))
      .addStringOption((option) => option.setName("progress-completed").setDescription("Custom completed emoji; paste an emoji or enter its server name."))
      .addStringOption((option) => option.setName("progress-remaining").setDescription("Custom remaining emoji; paste an emoji or enter its server name."))
      .addStringOption((option) => option.setName("progress-playing").setDescription("Custom current-position emoji while playing."))
      .addStringOption((option) => option.setName("progress-paused").setDescription("Custom current-position emoji while paused."))
      .addStringOption((option) => option.setName("progress-ending").setDescription("Optional ending emoji, or 'none' to remove it.")))
    .addSubcommand((command) => command.setName("access").setDescription("Shows configured access roles and what each group controls."))
    .addSubcommand((command) => command.setName("audit-log").setDescription("Configures the channel that receives settings/setup change logs.")
      .addChannelOption((option) => option.setName("channel").setDescription("Text channel to receive audit log entries.").addChannelTypes(ChannelType.GuildText))
      .addBooleanOption((option) => option.setName("disable").setDescription("Stop sending audit log entries.")))
    .addSubcommand((command) => command.setName("audit").setDescription("Shows recent settings/setup change log entries.")
      .addIntegerOption((option) => option.setName("count").setDescription("How many recent entries to show (default 10).").setMinValue(1).setMaxValue(20)))
    .addSubcommand((command) => command.setName("roles").setDescription("Adds access roles without removing existing ones.")
      .addRoleOption((option) => option.setName("administrator").setDescription("Adds a bot administrator role for /settings and inherited music control."))
      .addRoleOption((option) => option.setName("music-controller").setDescription("Adds a role for /play, queue commands, panel controls, and typed song requests."))
      .addRoleOption((option) => option.setName("restricted").setDescription("Adds a role denied from music and chatbot unless bot-owner bypass applies.")))
    .addSubcommand((command) => command.setName("role-add").setDescription("Adds a role to an access group.")
      .addStringOption((option) => this.addRoleGroupChoices(option.setName("group").setDescription("Access group.").setRequired(true)))
      .addRoleOption((option) => option.setName("role").setDescription("Role to add.").setRequired(true)))
    .addSubcommand((command) => command.setName("role-remove").setDescription("Removes a role from an access group.")
      .addStringOption((option) => this.addRoleGroupChoices(option.setName("group").setDescription("Access group.").setRequired(true)))
      .addRoleOption((option) => option.setName("role").setDescription("Role to remove.").setRequired(true)))
    .addSubcommand((command) => command.setName("volume").setDescription("Updates music volume limits.")
      .addIntegerOption((option) => option.setName("default").setDescription("Default volume.").setMinValue(0).setMaxValue(1000))
      .addIntegerOption((option) => option.setName("maximum").setDescription("Maximum volume.").setMinValue(1).setMaxValue(1000))
      .addIntegerOption((option) => option.setName("button-step").setDescription("Panel adjustment amount.").setMinValue(1).setMaxValue(100)))
    .addSubcommand((command) => command.setName("lifecycle").setDescription("Updates empty queue/channel behavior.")
      .addStringOption((option) => option.setName("empty-queue-action").setDescription("Action when the queue ends.")
        .addChoices({ name: "Disconnect", value: "disconnect" }, { name: "Stay connected", value: "stay_connected" }))
      .addIntegerOption((option) => option.setName("queue-delay-seconds").setDescription("Delay before empty-queue action.").setMinValue(0).setMaxValue(86400))
      .addStringOption((option) => option.setName("empty-channel-action").setDescription("Action when everyone leaves.")
        .addChoices({ name: "Continue", value: "continue" }, { name: "Pause", value: "pause" }, { name: "Disconnect", value: "disconnect" }))
      .addIntegerOption((option) => option.setName("channel-grace-seconds").setDescription("Grace period before action.").setMinValue(0).setMaxValue(86400))
      .addBooleanOption((option) => option.setName("resume-when-occupied").setDescription("Resume after an automatic pause.")))
    .addSubcommand((command) => command.setName("chatbot").setDescription("Configures mention-based AI replies.")
      .addBooleanOption((option) => option.setName("enabled").setDescription("Reply when permitted users mention the bot."))
      .addRoleOption((option) => option.setName("role").setDescription("Adds a role allowed to use mention chat."))
      .addChannelOption((option) => option.setName("channel").setDescription("Adds a text channel where mention chat is allowed.").addChannelTypes(ChannelType.GuildText))
      .addIntegerOption((option) => option.setName("cooldown-seconds").setDescription("Per-user delay between requests.").setMinValue(0).setMaxValue(86400))
      .addStringOption((option) => option.setName("denied-message").setDescription("Playful response shown to users without access.").setMaxLength(500))
      .addStringOption((option) => option.setName("denied-link-url").setDescription("Optional link button URL shown with the denied message. Use \"none\" to remove it."))
      .addStringOption((option) => option.setName("denied-link-label").setDescription("Label for the denied-message link button.").setMaxLength(80))
      .addBooleanOption((option) => option.setName("web-search").setDescription("Allow the model to search the public web when needed."))
      .addBooleanOption((option) => option.setName("image-input").setDescription("Allow bounded image attachments from Discord."))
      .addBooleanOption((option) => option.setName("image-generation").setDescription("Allow the model to generate images in mention chat."))
      .addBooleanOption((option) => option.setName("include-sources").setDescription("Include web citation links in replies."))
      .addIntegerOption((option) => option.setName("max-images").setDescription("Maximum images accepted per request.").setMinValue(0).setMaxValue(4))
      .addAttachmentOption((option) => option.setName("personality").setDescription("Upload the guild personality as a Markdown file."))
      .addBooleanOption((option) => option.setName("use-default-personality").setDescription("Remove the uploaded personality and use the built-in/default file.")))
    .addSubcommand((command) => command.setName("birthdays").setDescription("Configures automatic birthday announcements.")
      .addBooleanOption((option) => option.setName("enabled").setDescription("Turn birthday announcements on or off."))
      .addChannelOption((option) => option.setName("channel").setDescription("Text channel where birthday announcements are posted.").addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((command) => command.setName("nsfw").setDescription("Turns NSFW image commands on or off for this server.")
      .addBooleanOption((option) => option.setName("enabled").setDescription("Allow NSFW image commands (still requires an age-restricted channel).").setRequired(true)))
    .addSubcommand((command) => command.setName("link-fix").setDescription("Configures automatic link rewriting for better embeds (Twitter/X, TikTok, Instagram, Reddit).")
      .addBooleanOption((option) => option.setName("enabled").setDescription("Turn automatic link rewriting on or off."))
      .addChannelOption((option) => option.setName("channel").setDescription("Adds a text channel to watch for rewritable links.").addChannelTypes(ChannelType.GuildText))
      .addChannelOption((option) => option.setName("remove-channel").setDescription("Removes a text channel from the watched list.").addChannelTypes(ChannelType.GuildText)));

  public readonly module = CommandModule.Common;
  public readonly access = {
    ...publicAccessPolicy,
    roles: { match: RoleMatchMode.Any, requiredGroups: ["botAdministrator" as const] },
  };

  public constructor(
    private readonly profiles: GuildConfigurationProvider,
    private readonly assets: GuildAssetStore,
    private readonly applicationEmojiCatalog: ApplicationEmojiCatalog,
    private readonly auditLogService?: AuditLogService,
  ) {}

  public bindControlChannelService(service: ControlChannelService): void {
    this.controlChannelService = service;
  }

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.guildId) return;
    await context.responses.defer();
    const previousProfile = this.profiles.require(context.interaction.guildId);
    const input: UpdateGuildConfigurationInput = {};
    const subcommand = context.interaction.options.getSubcommand(true);

    if (subcommand === "access") {
      await context.responses.edit(this.formatAccessSummary(previousProfile));
      return;
    }

    if (subcommand === "audit") {
      await context.responses.edit(await this.formatAuditSummary(
        context.interaction.guildId,
        context.interaction.options.getInteger("count") ?? 10,
      ));
      return;
    }

    if (subcommand === "audit-log") {
      const channel = context.interaction.options.getChannel("channel");
      const disable = context.interaction.options.getBoolean("disable");
      if (channel) input.auditLogChannelId = channel.id;
      if (disable === true) input.auditLogChannelId = null;
    }

    if (subcommand === "panel") {
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
        input.idleImageAsset = await this.assets.saveIdleImage(context.interaction.guildId, attachment);
        input.idleImageUrl = null;
      }
      if (useDefault === true) {
        input.idleImageUrl = null;
        input.idleImageAsset = null;
      }
      try {
        const progressBar = await this.buildProgressBarSettings(
          context.interaction.guild,
          context,
          previousProfile.panel.progressBar,
        );
        if (progressBar) input.progressBar = progressBar;
      } catch (error) {
        await context.responses.edit(
          error instanceof Error ? error.message : "The progress bar settings are invalid.",
        );
        return;
      }
    } else if (subcommand === "roles") {
      const administrator = context.interaction.options.getRole("administrator");
      const controller = context.interaction.options.getRole("music-controller");
      const restricted = context.interaction.options.getRole("restricted");
      if (administrator) {
        input.botAdministratorRoleIds = [...new Set([
          ...previousProfile.roles.botAdministrator,
          administrator.id,
        ])];
      }
      if (controller) {
        input.musicControllerRoleIds = [...new Set([
          ...previousProfile.roles.musicController,
          controller.id,
        ])];
      }
      if (restricted) {
        input.restrictedRoleIds = [...new Set([
          ...previousProfile.roles.restricted,
          restricted.id,
        ])];
      }
    } else if (subcommand === "role-add" || subcommand === "role-remove") {
      const group = context.interaction.options.getString("group", true) as
        | "botAdministrator"
        | "musicController"
        | "restricted"
        | "chatbot";
      const role = context.interaction.options.getRole("role", true);
      const roleIds = new Set(previousProfile.roles[group]);
      if (subcommand === "role-add") roleIds.add(role.id);
      else roleIds.delete(role.id);
      const validationError = this.validateRoleGroupUpdate(previousProfile, group, roleIds);
      if (validationError) {
        await context.responses.edit(validationError);
        return;
      }
      if (group === "botAdministrator") input.botAdministratorRoleIds = [...roleIds];
      if (group === "musicController") input.musicControllerRoleIds = [...roleIds];
      if (group === "restricted") input.restrictedRoleIds = [...roleIds];
      if (group === "chatbot") input.chatbotRoleIds = [...roleIds];
    } else if (subcommand === "volume") {
      this.assignNumber(context, input, "default", "defaultVolume");
      this.assignNumber(context, input, "maximum", "maximumVolume");
      this.assignNumber(context, input, "button-step", "volumeButtonStep");
    } else if (subcommand === "lifecycle") {
      const queueAction = context.interaction.options.getString("empty-queue-action");
      const channelAction = context.interaction.options.getString("empty-channel-action");
      const queueDelay = context.interaction.options.getInteger("queue-delay-seconds");
      const channelGrace = context.interaction.options.getInteger("channel-grace-seconds");
      const resume = context.interaction.options.getBoolean("resume-when-occupied");
      if (queueAction) input.emptyQueueAction = queueAction as "disconnect" | "stay_connected";
      if (channelAction) input.emptyChannelAction = channelAction as "continue" | "pause" | "disconnect";
      if (queueDelay !== null) input.emptyQueueDelayMs = queueDelay * 1000;
      if (channelGrace !== null) input.emptyChannelGracePeriodMs = channelGrace * 1000;
      if (resume !== null) input.resumeWhenOccupied = resume;
    } else if (subcommand === "chatbot") {
      const enabled = context.interaction.options.getBoolean("enabled");
      const role = context.interaction.options.getRole("role");
      const channel = context.interaction.options.getChannel("channel");
      const cooldown = context.interaction.options.getInteger("cooldown-seconds");
      const deniedMessage = context.interaction.options.getString("denied-message");
      const deniedLinkUrl = context.interaction.options.getString("denied-link-url");
      const deniedLinkLabel = context.interaction.options.getString("denied-link-label");
      const webSearch = context.interaction.options.getBoolean("web-search");
      const imageInput = context.interaction.options.getBoolean("image-input");
      const imageGeneration = context.interaction.options.getBoolean("image-generation");
      const includeSources = context.interaction.options.getBoolean("include-sources");
      const maxImages = context.interaction.options.getInteger("max-images");
      const personality = context.interaction.options.getAttachment("personality");
      const useDefaultPersonality = context.interaction.options.getBoolean("use-default-personality");
      if (personality && useDefaultPersonality === true) {
        await context.responses.edit(
          "Choose either a personality upload or the default personality, not both.",
        );
        return;
      }
      if (enabled !== null) input.chatbotEnabled = enabled;
      if (role) {
        input.chatbotRoleIds = [...new Set([...previousProfile.roles.chatbot, role.id])];
      }
      if (channel) {
        input.chatbotChannelIds = [...new Set([...previousProfile.channels.chatbot, channel.id])];
      }
      if (cooldown !== null) input.chatbotCooldownSeconds = cooldown;
      if (deniedMessage) input.chatbotDeniedMessage = deniedMessage;
      if (deniedLinkUrl !== null) {
        input.chatbotDeniedLinkUrl = deniedLinkUrl.trim().toLowerCase() === "none" ? null : deniedLinkUrl;
      }
      if (deniedLinkLabel !== null) input.chatbotDeniedLinkLabel = deniedLinkLabel;
      if (webSearch !== null) input.chatbotWebSearchMode = webSearch ? "auto" : "off";
      if (imageInput !== null) input.chatbotImageInputEnabled = imageInput;
      if (imageGeneration !== null) input.chatbotImageGenerationEnabled = imageGeneration;
      if (includeSources !== null) input.chatbotIncludeSources = includeSources;
      if (maxImages !== null) input.chatbotMaxImagesPerRequest = maxImages;
      if (personality) {
        input.chatbotPersonalityAsset = await this.assets.savePersonality(
          context.interaction.guildId,
          personality,
        );
        input.chatbotPersonalityFile = null;
      }
      if (useDefaultPersonality === true) {
        input.chatbotPersonalityAsset = null;
        input.chatbotPersonalityFile = null;
      }
    } else if (subcommand === "birthdays") {
      const enabled = context.interaction.options.getBoolean("enabled");
      const channel = context.interaction.options.getChannel("channel");
      if (channel) input.birthdayAnnouncementsChannelId = channel.id;
      if (enabled !== null) input.birthdaysEnabled = enabled;
      const nextEnabled = enabled ?? previousProfile.features.birthdays;
      const nextChannel = channel?.id ?? previousProfile.channels.birthdayAnnouncements;
      if (nextEnabled && !nextChannel) {
        await context.responses.edit(
          "Set a birthday-announcements channel with `channel:<channel>` before enabling this feature.",
        );
        return;
      }
    } else if (subcommand === "nsfw") {
      input.nsfwEnabled = context.interaction.options.getBoolean("enabled", true);
    } else if (subcommand === "link-fix") {
      const enabled = context.interaction.options.getBoolean("enabled");
      const channel = context.interaction.options.getChannel("channel");
      const removeChannel = context.interaction.options.getChannel("remove-channel");
      const channelIds = new Set(previousProfile.channels.linkFix);
      if (channel) channelIds.add(channel.id);
      if (removeChannel) channelIds.delete(removeChannel.id);
      if (channel || removeChannel) input.linkFixChannelIds = [...channelIds];
      if (enabled !== null) input.linkFixEnabled = enabled;
      const nextEnabled = enabled ?? previousProfile.features.linkFix;
      const nextChannelCount = input.linkFixChannelIds?.length ?? previousProfile.channels.linkFix.size;
      if (nextEnabled && nextChannelCount === 0) {
        await context.responses.edit(
          "Add at least one watched channel with `channel:<channel>` before enabling this feature.",
        );
        return;
      }
    }

    if (Object.keys(input).length === 0) {
      await context.responses.edit("Provide at least one setting to change.");
      return;
    }
    const updatedProfile = await this.profiles.update(context.interaction.guildId, input);
    await this.syncControlPanel(context.interaction.guildId, subcommand, input, updatedProfile);
    if (
      previousProfile.idleImageAsset &&
      previousProfile.idleImageAsset !== updatedProfile.idleImageAsset
    ) {
      await this.assets.removeIdleImage(previousProfile.idleImageAsset);
    }
    if (
      previousProfile.chat.personalityAsset &&
      previousProfile.chat.personalityAsset !== updatedProfile.chat.personalityAsset
    ) {
      await this.assets.removePersonality(previousProfile.chat.personalityAsset);
    }
    const description = this.describeUpdate(subcommand, previousProfile, updatedProfile);
    await this.auditLogService?.log(
      context.interaction.guildId,
      context.interaction.user.id,
      `**/settings ${subcommand}**\n${description}`,
    );
    await context.responses.edit(
      input.progressBar
        ? `${description}\n\nPreview:\n${this.renderProgressPreview(input.progressBar)}`
        : description,
    );
  }

  private async syncControlPanel(
    guildId: string,
    subcommand: string,
    input: UpdateGuildConfigurationInput,
    profile: GuildConfiguration,
  ): Promise<void> {
    if (!this.controlChannelService || !profile.features.music || !profile.channels.controlPanel) {
      return;
    }

    if (input.controlPanelChannelId) {
      await this.controlChannelService.ensureGuildPanel(guildId);
      return;
    }

    if (
      subcommand === "panel" &&
      (
        input.idleImageUrl !== undefined ||
        input.idleImageAsset !== undefined ||
        input.progressBar !== undefined
      )
    ) {
      await this.controlChannelService.refreshPanel(guildId, {
        forceIdleImage:
          input.idleImageAsset !== undefined ||
          (input.idleImageUrl === null && input.idleImageAsset === null),
      });
    }
  }

  private async formatAuditSummary(guildId: string, count: number): Promise<string> {
    if (!this.auditLogService) return "Audit logging isn't available right now.";
    const result = await this.auditLogService.fetchRecent(guildId, count);
    if (!result.configured) {
      return "No audit log channel is configured. Set one with `/settings audit-log channel:<channel>`.";
    }
    if (result.entries.length === 0) {
      return "No audit log entries found yet.";
    }
    const lines = result.entries.map((entry) => {
      const oneLine = entry.description.replaceAll("\n", " · ");
      return `<t:${Math.floor(entry.createdAt / 1_000)}:R> ${oneLine}`;
    });
    return ["Recent audit log entries:", ...lines].join("\n").slice(0, 2_000);
  }

  private formatAccessSummary(profile: GuildConfiguration): string {
    return [
      "Configured access roles:",
      `Bot administrator: ${formatRoleGroupList(profile.roles.botAdministrator)}`,
      `Music controller: ${formatRoleGroupList(profile.roles.musicController)}`,
      `Restricted: ${formatRoleGroupList(profile.roles.restricted)}`,
      `Chatbot: ${formatRoleGroupList(profile.roles.chatbot)}`,
      "",
      "Role purposes:",
      `- Bot administrator: ${roleGroupDescriptions.botAdministrator}`,
      `- Music controller: ${roleGroupDescriptions.musicController}`,
      `- Restricted: ${roleGroupDescriptions.restricted}`,
      `- Chatbot: ${roleGroupDescriptions.chatbot}`,
    ].join("\n");
  }

  private validateRoleGroupUpdate(
    profile: GuildConfiguration,
    group: "botAdministrator" | "musicController" | "restricted" | "chatbot",
    nextRoleIds: ReadonlySet<string>,
  ): string | null {
    if (group === "botAdministrator" && nextRoleIds.size === 0) {
      return "At least one bot-administrator role must remain configured.";
    }
    if (group === "musicController" && profile.features.music && nextRoleIds.size === 0) {
      return "Music is enabled, so at least one music-controller role must remain configured.";
    }
    if (group === "chatbot" && profile.features.chatbot && nextRoleIds.size === 0) {
      return "Chatbot is enabled, so at least one chatbot role must remain configured (or disable the chatbot feature first).";
    }
    return null;
  }

  private describeUpdate(
    subcommand: string,
    previousProfile: GuildConfiguration,
    updatedProfile: GuildConfiguration,
  ): string {
    if (subcommand === "roles" || subcommand === "role-add" || subcommand === "role-remove") {
      return [
        "Access roles updated.",
        `Music controller: ${formatRoleGroupList(updatedProfile.roles.musicController)}`,
        roleGroupDescriptions.musicController,
      ].join("\n");
    }
    if (
      subcommand === "panel" &&
      (
        previousProfile.idleImageUrl !== updatedProfile.idleImageUrl ||
        previousProfile.idleImageAsset !== updatedProfile.idleImageAsset ||
        previousProfile.channels.controlPanel !== updatedProfile.channels.controlPanel ||
        previousProfile.panel.progressBar.style !== updatedProfile.panel.progressBar.style ||
        previousProfile.panel.progressBar.length !== updatedProfile.panel.progressBar.length ||
        previousProfile.panel.progressBar.customTheme !== updatedProfile.panel.progressBar.customTheme
      )
    ) {
      return "Panel settings updated. The control panel has been refreshed.";
    }
    if (subcommand === "chatbot" && updatedProfile.roles.chatbot.size !== previousProfile.roles.chatbot.size) {
      return [
        "Chatbot settings updated.",
        `Chatbot roles: ${formatRoleGroupList(updatedProfile.roles.chatbot)}`,
        roleGroupDescriptions.chatbot,
      ].join("\n");
    }
    const changes = this.describeFieldChanges(previousProfile, updatedProfile);
    if (changes.length === 0) return "Server settings updated.";
    const lines = ["Server settings updated.", ...changes];
    if (
      changes.some((line) => line.startsWith("Chatbot")) &&
      !updatedProfile.features.chatbot
    ) {
      lines.push("Note: the chatbot feature is currently disabled, so this has no effect until it's enabled.");
    }
    return lines.join("\n");
  }

  private describeFieldChanges(
    previous: GuildConfiguration,
    updated: GuildConfiguration,
  ): string[] {
    const fields: Array<{ label: string; previous: unknown; updated: unknown }> = [
      { label: "Audit log channel", previous: previous.channels.auditLog, updated: updated.channels.auditLog },
      { label: "Default volume", previous: previous.music.defaultVolume, updated: updated.music.defaultVolume },
      { label: "Maximum volume", previous: previous.music.maximumVolume, updated: updated.music.maximumVolume },
      { label: "Volume button step", previous: previous.music.volumeButtonStep, updated: updated.music.volumeButtonStep },
      { label: "Empty-queue action", previous: previous.music.emptyQueueAction, updated: updated.music.emptyQueueAction },
      { label: "Empty-queue delay (ms)", previous: previous.music.emptyQueueDelayMs, updated: updated.music.emptyQueueDelayMs },
      { label: "Empty-channel action", previous: previous.music.emptyChannelAction, updated: updated.music.emptyChannelAction },
      { label: "Empty-channel grace period (ms)", previous: previous.music.emptyChannelGracePeriodMs, updated: updated.music.emptyChannelGracePeriodMs },
      { label: "Resume when occupied", previous: previous.music.resumeWhenOccupied, updated: updated.music.resumeWhenOccupied },
      { label: "Chatbot enabled", previous: previous.features.chatbot, updated: updated.features.chatbot },
      { label: "Chatbot cooldown (seconds)", previous: previous.chat.cooldownSeconds, updated: updated.chat.cooldownSeconds },
      { label: "Chatbot denied message", previous: previous.chat.deniedMessage, updated: updated.chat.deniedMessage },
      { label: "Chatbot denied-message link URL", previous: previous.chat.deniedLinkUrl, updated: updated.chat.deniedLinkUrl },
      { label: "Chatbot denied-message link label", previous: previous.chat.deniedLinkLabel, updated: updated.chat.deniedLinkLabel },
      { label: "Chatbot web search mode", previous: previous.chat.webSearchMode, updated: updated.chat.webSearchMode },
      { label: "Chatbot image input", previous: previous.chat.imageInputEnabled, updated: updated.chat.imageInputEnabled },
      { label: "Chatbot image generation", previous: previous.chat.imageGenerationEnabled, updated: updated.chat.imageGenerationEnabled },
      { label: "Chatbot include sources", previous: previous.chat.includeSources, updated: updated.chat.includeSources },
      { label: "Chatbot max images per request", previous: previous.chat.maxImagesPerRequest, updated: updated.chat.maxImagesPerRequest },
      { label: "Birthdays enabled", previous: previous.features.birthdays, updated: updated.features.birthdays },
      { label: "Birthday announcements channel", previous: previous.channels.birthdayAnnouncements, updated: updated.channels.birthdayAnnouncements },
      { label: "NSFW commands enabled", previous: previous.features.nsfw, updated: updated.features.nsfw },
      { label: "Link fix enabled", previous: previous.features.linkFix, updated: updated.features.linkFix },
    ];
    const changes = fields
      .filter((field) => field.previous !== field.updated)
      .map((field) => `${field.label}: ${String(field.previous)} → ${String(field.updated)}`);
    if (
      previous.channels.linkFix.size !== updated.channels.linkFix.size ||
      [...previous.channels.linkFix].some((id) => !updated.channels.linkFix.has(id))
    ) {
      changes.push(`Link fix watched channels: ${this.formatChannelList(updated.channels.linkFix)}`);
    }
    return changes;
  }

  private formatChannelList(channelIds: ReadonlySet<string>): string {
    return channelIds.size === 0 ? "none" : [...channelIds].map((id) => `<#${id}>`).join(", ");
  }

  private assignNumber(
    context: CommandContext,
    input: UpdateGuildConfigurationInput,
    option: string,
    field: "defaultVolume" | "maximumVolume" | "volumeButtonStep",
  ): void {
    const value = context.interaction.options.getInteger(option);
    if (value !== null) input[field] = value;
  }

  private async buildProgressBarSettings(
    guild: Guild | null,
    context: CommandContext,
    current: ProgressBarSettings,
  ): Promise<ProgressBarSettings | null> {
    const style = context.interaction.options.getString("progress-style") as ProgressBarStyle | null;
    const length = context.interaction.options.getInteger("progress-length");
    const values = {
      completed: context.interaction.options.getString("progress-completed"),
      remaining: context.interaction.options.getString("progress-remaining"),
      playing: context.interaction.options.getString("progress-playing"),
      paused: context.interaction.options.getString("progress-paused"),
      ending: context.interaction.options.getString("progress-ending"),
    };
    const hasCustomInput = Object.values(values).some((value) => value !== null);
    if (!style && length === null && !hasCustomInput) return null;

    let customTheme = current.customTheme;
    if (hasCustomInput) {
      if (!guild) throw new Error("Custom progress emojis can only be configured in a server.");
      const emojis = await guild.emojis.fetch();
      const requiredKeys = ["completed", "remaining", "playing", "paused"] as const;
      const resolved = { ...customTheme } as Partial<CustomProgressBarTheme>;
      for (const key of requiredKeys) {
        const value = values[key];
        if (value) resolved[key] = this.resolveGuildEmoji(guild.id, emojis.values(), value);
      }
      if (values.ending) {
        resolved.ending = values.ending.toLowerCase() === "none"
          ? null
          : this.resolveGuildEmoji(guild.id, emojis.values(), values.ending);
      }
      const missing = requiredKeys.filter((key) => !resolved[key]);
      if (missing.length > 0) {
        throw new Error(`A custom theme still needs: ${missing.join(", ")}.`);
      }
      customTheme = {
        completed: resolved.completed!,
        remaining: resolved.remaining!,
        playing: resolved.playing!,
        paused: resolved.paused!,
        ending: resolved.ending ?? null,
      };
    }

    const nextStyle = style ?? (hasCustomInput ? "custom" : current.style);
    if (nextStyle === "yohta" && !this.applicationEmojiCatalog.getYohtaTheme()) {
      throw new Error(
        `The Yohta preset is not provisioned for this bot application. Missing: ${this.applicationEmojiCatalog.getMissingYohtaEmojiNames().join(", ")}.`,
      );
    }
    if (nextStyle === "custom" && !customTheme) {
      throw new Error("Configure completed, remaining, playing, and paused emojis before selecting custom.");
    }
    return {
      style: nextStyle,
      length: length ?? current.length,
      customTheme,
    };
  }

  private resolveGuildEmoji(
    guildId: string,
    emojis: IterableIterator<GuildEmoji>,
    input: string,
  ): ProgressBarEmojiReference {
    const all = [...emojis];
    const mention = input.trim().match(/^<(a?):([A-Za-z0-9_]+):(\d{17,20})>$/);
    const normalizedName = input.trim().replace(/^:|:$/g, "");
    const emoji = mention
      ? all.find((candidate) => candidate.id === mention[3])
      : all.find((candidate) => candidate.name === normalizedName);
    if (!emoji || emoji.guild.id !== guildId) {
      throw new Error(`Emoji "${input}" was not found in this server.`);
    }
    if (!emoji.available) throw new Error(`Emoji "${emoji.name}" is currently unavailable.`);
    return {
      id: emoji.id,
      name: emoji.name ?? normalizedName,
      animated: emoji.animated ?? false,
      scope: "guild",
      guildId,
    };
  }

  private renderProgressPreview(settings: ProgressBarSettings): string {
    return renderProgressBar({
      positionMs: 158_000,
      durationMs: 224_000,
      paused: false,
      isStream: false,
      settings,
      presetTheme: this.applicationEmojiCatalog.getYohtaTheme(),
    });
  }

  private addRoleGroupChoices<T extends { addChoices: (...choices: { name: string; value: string }[]) => T }>(
    option: T,
  ): T {
    return option.addChoices(
      { name: "Bot administrator (/settings)", value: "botAdministrator" },
      { name: "Music controller (/play, panel, control channel)", value: "musicController" },
      { name: "Restricted (deny music and chatbot)", value: "restricted" },
      { name: "Chatbot (mention replies)", value: "chatbot" },
    );
  }
}
