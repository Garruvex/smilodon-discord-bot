import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Role,
  type TextChannel,
} from "discord.js";
import type { Logger } from "pino";

import type { ControlChannelService } from "../control-panel/control-channel-service.js";
import type { GuildCommandDeploymentService } from "../commands/guild-command-deployment-service.js";
import type {
  GuildSetupInitializeRequest,
  GuildSetupResult,
  GuildSetupService,
  GuildSetupStatus,
} from "./guild-setup-service.js";
import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../../config/guild-configuration.js";

export class LocalGuildSetupService implements GuildSetupService {
  public constructor(
    private readonly guildConfigurationProvider: GuildConfigurationProvider,
    private readonly commandDeploymentService: GuildCommandDeploymentService,
    private readonly controlChannelService: ControlChannelService,
    private readonly logger: Logger,
  ) {}

  public async initialize(
    request: GuildSetupInitializeRequest,
  ): Promise<GuildSetupResult> {
    const existingProfile = this.guildConfigurationProvider.find(request.guild.id);
    if (existingProfile) {
      return this.completeSetup(request.guild, existingProfile);
    }

    this.assertBotPermissions(request.guild);

    const botAdministratorRole =
      request.botAdministratorRole ??
      (await this.createRole(request.guild, "Bot Administrator"));
    const musicControllerRole =
      request.musicControllerRole ??
      (await this.createRole(request.guild, "Music Controller"));
    const restrictedRole =
      request.restrictedRole ??
      (await this.createRole(request.guild, "Bot Restricted"));
    const controlChannel =
      request.controlChannel ?? (await this.createControlChannel(request.guild));

    await this.grantRoleIfMissing(
      request.initializedBy,
      botAdministratorRole,
      "Granted during initial bot guild setup",
    );
    await this.grantRoleIfMissing(
      request.initializedBy,
      musicControllerRole,
      "Granted during initial bot guild setup",
    );

    const profile = await this.guildConfigurationProvider.create({
      guildId: request.guild.id,
      guildName: request.guild.name,
      displayName: request.displayName,
      embedColor: "#3B82F6",
      idleImageUrl: request.idleImageUrl,
      botAdministratorRoleIds: [botAdministratorRole.id],
      musicControllerRoleIds: [musicControllerRole.id],
      restrictedRoleIds: [restrictedRole.id],
      controlPanelChannelId: controlChannel.id,
    });

    return this.completeSetup(request.guild, profile);
  }

  private async completeSetup(
    guild: Guild,
    profile: GuildConfiguration,
  ): Promise<GuildSetupResult> {
    const controlChannelId = profile.channels.controlPanel;
    if (!controlChannelId) {
      throw new Error("The existing guild profile has no music control channel.");
    }

    const controlChannel = await guild.channels.fetch(controlChannelId);
    if (!controlChannel || controlChannel.type !== ChannelType.GuildText) {
      throw new Error("The configured music control channel is missing or is not a text channel.");
    }

    const botAdministratorRoleId = this.firstRoleId(
      profile.roles.botAdministrator,
      "bot-administrator",
    );
    const musicControllerRoleId = this.firstRoleId(
      profile.roles.musicController,
      "music-controller",
    );
    const restrictedRoleId = this.firstRoleId(profile.roles.restricted, "restricted");
    await this.controlChannelService.ensureGuildPanel(profile.guildId);
    const deployedCommandCount = await this.commandDeploymentService.deploy(profile);

    this.logger.info(
      {
        guildId: profile.guildId,
        controlChannelId,
        deployedCommandCount,
      },
      "Guild setup completed or resumed",
    );

    return {
      guildId: profile.guildId,
      controlChannelId,
      botAdministratorRoleId,
      musicControllerRoleId,
      restrictedRoleId,
      deployedCommandCount,
    };
  }

  public status(guildId: string): GuildSetupStatus {
    const profile = this.guildConfigurationProvider.find(guildId);
    if (!profile) {
      return {
        configured: false,
        profileFile: null,
        controlPanelChannelId: null,
        enabledFeatures: [],
        access: null,
      };
    }

    return {
      configured: true,
      profileFile: profile.sourceFile,
      controlPanelChannelId: profile.channels.controlPanel,
      enabledFeatures: Object.entries(profile.features)
        .filter(([, enabled]) => enabled)
        .map(([feature]) => feature),
      access: {
        botAdministrator: profile.roles.botAdministrator,
        musicController: profile.roles.musicController,
        restricted: profile.roles.restricted,
        chatbot: profile.roles.chatbot,
      },
    };
  }

  private assertBotPermissions(guild: Guild): void {
    const botMember = guild.members.me;
    const required = [
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory,
    ];

    if (!botMember?.permissions.has(required)) {
      throw new Error(
        "The bot needs Manage Channels, Manage Roles, Manage Messages, Send Messages, Embed Links, and Read Message History before setup.",
      );
    }
  }

  private createRole(guild: Guild, name: string): Promise<Role> {
    return guild.roles.create({ name, reason: "Initial bot guild setup" });
  }

  private async grantRoleIfMissing(
    member: GuildMember,
    role: Role,
    reason: string,
  ): Promise<void> {
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role, reason);
    }
  }

  private async createControlChannel(guild: Guild): Promise<TextChannel> {
    const channel = await guild.channels.create({
      name: "music-control",
      type: ChannelType.GuildText,
      topic: "Persistent music control channel",
      reason: "Initial bot guild setup",
    });
    return channel;
  }

  private firstRoleId(roleIds: ReadonlySet<string>, label: string): string {
    const roleId = roleIds.values().next().value;
    if (!roleId) {
      throw new Error(`The existing guild profile has no ${label} role.`);
    }
    return roleId;
  }
}
