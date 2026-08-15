import { ChannelType, SlashCommandBuilder } from "discord.js";

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

export class SettingsCommand implements BotCommand {
  private controlChannelService: ControlChannelService | null = null;

  public readonly definition = new SlashCommandBuilder()
    .setName("settings")
    .setDescription("Updates this server's bot configuration.")
    .addSubcommand((command) => command.setName("panel").setDescription("Updates the music panel.")
      .addChannelOption((option) => option.setName("channel").setDescription("Music control channel.").addChannelTypes(ChannelType.GuildText))
      .addStringOption((option) => option.setName("idle-image-url").setDescription("Stable HTTPS idle image URL."))
      .addAttachmentOption((option) => option.setName("idle-image").setDescription("Upload a persistent PNG, JPEG, WebP, or GIF idle image."))
      .addBooleanOption((option) => option.setName("use-default-image").setDescription("Use the bundled Smilodon idle image.")))
    .addSubcommand((command) => command.setName("access").setDescription("Shows configured access roles and what each group controls."))
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
      .addBooleanOption((option) => option.setName("web-search").setDescription("Allow the model to search the public web when needed."))
      .addBooleanOption((option) => option.setName("image-input").setDescription("Allow bounded image attachments from Discord."))
      .addBooleanOption((option) => option.setName("include-sources").setDescription("Include web citation links in replies."))
      .addIntegerOption((option) => option.setName("max-images").setDescription("Maximum images accepted per request.").setMinValue(0).setMaxValue(4))
      .addAttachmentOption((option) => option.setName("personality").setDescription("Upload the guild personality as a Markdown file."))
      .addBooleanOption((option) => option.setName("use-default-personality").setDescription("Remove the uploaded personality and use the built-in/default file.")));

  public readonly module = CommandModule.Common;
  public readonly access = {
    ...publicAccessPolicy,
    roles: { match: RoleMatchMode.Any, requiredGroups: ["botAdministrator" as const] },
  };

  public constructor(
    private readonly profiles: GuildConfigurationProvider,
    private readonly assets: GuildAssetStore,
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
      const webSearch = context.interaction.options.getBoolean("web-search");
      const imageInput = context.interaction.options.getBoolean("image-input");
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
      if (webSearch !== null) input.chatbotWebSearchEnabled = webSearch;
      if (imageInput !== null) input.chatbotImageInputEnabled = imageInput;
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
    await context.responses.edit(this.describeUpdate(subcommand, previousProfile, updatedProfile));
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
      (input.idleImageUrl !== undefined || input.idleImageAsset !== undefined)
    ) {
      await this.controlChannelService.refreshPanel(guildId, {
        forceIdleImage:
          input.idleImageAsset !== undefined ||
          (input.idleImageUrl === null && input.idleImageAsset === null),
      });
    }
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
        previousProfile.channels.controlPanel !== updatedProfile.channels.controlPanel
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
    return "Server settings updated.";
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
