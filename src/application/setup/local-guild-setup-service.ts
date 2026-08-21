import type { Logger } from "pino";

import type { ControlChannelService } from "../control-panel/control-channel-service.js";
import type { GuildCommandDeploymentService } from "../commands/guild-command-deployment-service.js";
import type { GuildResourceGateway, GuildRoleHandle } from "./guild-resource-gateway.js";
import type {
  GuildSetupInitializeRequest,
  GuildSetupResult,
  GuildSetupService,
  GuildSetupStatus,
} from "./guild-setup-service.js";
import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../../config/guild-configuration.js";
import type { AuditLogService } from "../audit/audit-log-service.js";

interface CreatedResources {
  roleIds: string[];
  channelId: string | null;
}

export class LocalGuildSetupService implements GuildSetupService {
  public constructor(
    private readonly guildConfigurationProvider: GuildConfigurationProvider,
    private readonly commandDeploymentService: GuildCommandDeploymentService,
    private readonly controlChannelService: ControlChannelService,
    private readonly resourceGateway: GuildResourceGateway,
    private readonly logger: Logger,
    private readonly auditLogService?: AuditLogService,
  ) {}

  public async initialize(
    request: GuildSetupInitializeRequest,
  ): Promise<GuildSetupResult> {
    const existingProfile = this.guildConfigurationProvider.find(request.guildId);
    if (existingProfile) {
      return this.completeSetup(request.guildId, existingProfile, false);
    }

    await this.assertBotPermissions(request.guildId);

    // Track only the resources *this run* creates (not ones the caller
    // already supplied), so a failure partway through can clean them up
    // instead of leaving orphaned roles/channels behind on retry.
    const created: CreatedResources = { roleIds: [], channelId: null };
    let profile: GuildConfiguration;
    try {
      const botAdministratorRoleId = request.botAdministratorRoleId ??
        (await this.createTrackedRole(request.guildId, "Bot Administrator", created)).id;
      const musicControllerRoleId = request.musicControllerRoleId ??
        (await this.createTrackedRole(request.guildId, "Music Controller", created)).id;
      const restrictedRoleId = request.restrictedRoleId ??
        (await this.createTrackedRole(request.guildId, "Bot Restricted", created)).id;
      const controlChannelId = request.controlChannelId ?? await (async (): Promise<string> => {
        const channel = await this.resourceGateway.createTextChannel(
          request.guildId, "music-control", "Persistent music control channel", "Initial bot guild setup",
        );
        created.channelId = channel.id;
        return channel.id;
      })();

      await this.resourceGateway.grantRoleIfMissing(
        request.guildId,
        request.initializedByUserId,
        botAdministratorRoleId,
        "Granted during initial bot guild setup",
      );
      await this.resourceGateway.grantRoleIfMissing(
        request.guildId,
        request.initializedByUserId,
        musicControllerRoleId,
        "Granted during initial bot guild setup",
      );

      // Once the profile is persisted, a later failure (panel setup, command
      // deployment) leaves a recoverable state: re-running /setup initialize
      // finds the existing profile and retries completeSetup() against it,
      // so nothing below this point should roll back the roles/channel the
      // persisted profile now points to.
      profile = await this.guildConfigurationProvider.create({
        guildId: request.guildId,
        guildName: request.guildName,
        displayName: request.displayName,
        embedColor: "#3B82F6",
        idleImageUrl: request.idleImageUrl,
        botAdministratorRoleIds: [botAdministratorRoleId],
        musicControllerRoleIds: [musicControllerRoleId],
        restrictedRoleIds: [restrictedRoleId],
        controlPanelChannelId: controlChannelId,
      });
    } catch (error) {
      await this.rollbackCreatedResources(request.guildId, created);
      throw error;
    }

    const result = await this.completeSetup(request.guildId, profile, true);
    await this.auditLogService?.log(
      request.guildId,
      request.initializedByUserId,
      "**/setup initialize** — first-time server setup completed.",
    );
    return result;
  }

  private async createTrackedRole(
    guildId: string,
    name: string,
    created: CreatedResources,
  ): Promise<GuildRoleHandle> {
    const role = await this.resourceGateway.createRole(guildId, name, "Initial bot guild setup");
    created.roleIds.push(role.id);
    return role;
  }

  private async rollbackCreatedResources(
    guildId: string,
    created: CreatedResources,
  ): Promise<void> {
    for (const roleId of created.roleIds) {
      await this.resourceGateway.deleteRole(guildId, roleId, "Rolling back a failed bot guild setup").catch((error: unknown) => {
        this.logger.warn({ error, guildId, roleId }, "Unable to roll back a role created during failed setup");
      });
    }
    if (created.channelId) {
      await this.resourceGateway.deleteChannel(guildId, created.channelId, "Rolling back a failed bot guild setup").catch((error: unknown) => {
        this.logger.warn({ error, guildId, channelId: created.channelId }, "Unable to roll back a channel created during failed setup");
      });
    }
  }

  private async completeSetup(
    guildId: string,
    profile: GuildConfiguration,
    wasFreshSetup: boolean,
  ): Promise<GuildSetupResult> {
    const controlChannelId = profile.channels.controlPanel;
    if (!controlChannelId) {
      throw new Error("The existing guild profile has no music control channel.");
    }

    const controlChannel = await this.resourceGateway.fetchTextChannel(guildId, controlChannelId);
    if (!controlChannel) {
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

  public async status(guildId: string): Promise<GuildSetupStatus> {
    const botPermissions = await this.resourceGateway.checkBotPermissions(guildId);
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

  private async assertBotPermissions(guildId: string): Promise<void> {
    const status = await this.resourceGateway.checkBotPermissions(guildId);
    if (!status.ok) {
      throw new Error(
        `The bot is missing required permissions: ${status.missing.join(", ")}.`,
      );
    }
  }

  private firstRoleId(roleIds: ReadonlySet<string>, label: string): string {
    const roleId = roleIds.values().next().value;
    if (!roleId) {
      throw new Error(`The existing guild profile has no ${label} role.`);
    }
    return roleId;
  }
}
