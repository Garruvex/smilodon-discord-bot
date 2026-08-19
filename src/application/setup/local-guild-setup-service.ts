import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  type Guild,
  type GuildMember,
  type Role,
  type TextChannel,
} from "discord.js";
import type { Logger } from "pino";

import type { ControlChannelService } from "../control-panel/control-channel-service.js";
import type { GuildCommandDeploymentService } from "../commands/guild-command-deployment-service.js";
import type {
  GuildSetupBotPermissionStatus,
  GuildSetupInitializeRequest,
  GuildSetupResult,
  GuildSetupService,
  GuildSetupStatus,
} from "./guild-setup-service.js";
import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../../config/guild-configuration.js";
import type { AuditLogService } from "../audit/audit-log-service.js";

export class LocalGuildSetupService implements GuildSetupService {
  public constructor(
    private readonly guildConfigurationProvider: GuildConfigurationProvider,
    private readonly commandDeploymentService: GuildCommandDeploymentService,
    private readonly controlChannelService: ControlChannelService,
    private readonly logger: Logger,
    private readonly auditLogService?: AuditLogService,
  ) {}

  public async initialize(
    request: GuildSetupInitializeRequest,
  ): Promise<GuildSetupResult> {
    const existingProfile = this.guildConfigurationProvider.find(request.guild.id);
    if (existingProfile) {
      return this.completeSetup(request.guild, existingProfile, false);
    }

    this.assertBotPermissions(request.guild);

    // Track only the resources *this run* creates (not ones the caller
    // already supplied), so a failure partway through can clean them up
    // instead of leaving orphaned roles/channels behind on retry.
    const created: { roles: Role[]; channel: TextChannel | null } = { roles: [], channel: null };
    let profile: GuildConfiguration;
    try {
      const botAdministratorRole = request.botAdministratorRole ??
        await this.createTrackedRole(request.guild, "Bot Administrator", created);
      const musicControllerRole = request.musicControllerRole ??
        await this.createTrackedRole(request.guild, "Music Controller", created);
      const restrictedRole = request.restrictedRole ??
        await this.createTrackedRole(request.guild, "Bot Restricted", created);
      const controlChannel = request.controlChannel ?? await (async (): Promise<TextChannel> => {
        const channel = await this.createControlChannel(request.guild);
        created.channel = channel;
        return channel;
      })();

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

      // Once the profile is persisted, a later failure (panel setup, command
      // deployment) leaves a recoverable state: re-running /setup initialize
      // finds the existing profile and retries completeSetup() against it,
      // so nothing below this point should roll back the roles/channel the
      // persisted profile now points to.
      profile = await this.guildConfigurationProvider.create({
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
    } catch (error) {
      await this.rollbackCreatedResources(request.guild.id, created);
      throw error;
    }

    const result = await this.completeSetup(request.guild, profile, true);
    await this.auditLogService?.log(
      request.guild.id,
      request.initializedBy.id,
      "**/setup initialize** — first-time server setup completed.",
    );
    return result;
  }

  private async createTrackedRole(
    guild: Guild,
    name: string,
    created: { roles: Role[]; channel: TextChannel | null },
  ): Promise<Role> {
    const role = await this.createRole(guild, name);
    created.roles.push(role);
    return role;
  }

  private async rollbackCreatedResources(
    guildId: string,
    created: { roles: Role[]; channel: TextChannel | null },
  ): Promise<void> {
    for (const role of created.roles) {
      await role.delete("Rolling back a failed bot guild setup").catch((error: unknown) => {
        this.logger.warn({ error, guildId, roleId: role.id }, "Unable to roll back a role created during failed setup");
      });
    }
    if (created.channel) {
      await created.channel.delete("Rolling back a failed bot guild setup").catch((error: unknown) => {
        this.logger.warn({ error, guildId, channelId: created.channel?.id }, "Unable to roll back a channel created during failed setup");
      });
    }
  }

  private async completeSetup(
    guild: Guild,
    profile: GuildConfiguration,
    wasFreshSetup: boolean,
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
      wasFreshSetup,
    };
  }

  public status(guildId: string, guild?: Guild): GuildSetupStatus {
    const botPermissions = guild ? this.checkBotPermissions(guild) : null;
    const profile = this.guildConfigurationProvider.find(guildId);
    if (!profile) {
      return {
        configured: false,
        profileFile: null,
        controlPanelChannelId: null,
        enabledFeatures: [],
        access: null,
        botPermissions,
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
      botPermissions,
    };
  }

  private static readonly requiredBotPermissions = [
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
  ];

  private checkBotPermissions(guild: Guild): GuildSetupBotPermissionStatus {
    const botMember = guild.members.me;
    const missingFlags = LocalGuildSetupService.requiredBotPermissions.filter(
      (flag) => !botMember?.permissions.has(flag),
    );
    const missing = new PermissionsBitField(missingFlags).toArray();
    return { ok: missing.length === 0, missing };
  }

  private assertBotPermissions(guild: Guild): void {
    const status = this.checkBotPermissions(guild);
    if (!status.ok) {
      throw new Error(
        `The bot is missing required permissions: ${status.missing.join(", ")}.`,
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
