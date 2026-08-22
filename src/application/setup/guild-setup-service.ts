import type {
  GuildFeatureName,
  GuildChatConfiguration,
  GuildMusicConfiguration,
  GuildPanelConfiguration,
} from "../../config/guild-configuration.js";

export interface GuildSetupInitializeRequest {
  guildId: string;
  guildName: string;
  initializedByUserId: string;
  displayName: string;
  idleImageUrl: string | null;
  controlChannelId: string | null;
  botAdministratorRoleId: string | null;
  musicControllerRoleId: string | null;
  restrictedRoleId: string | null;
}

export interface GuildSetupResult {
  guildId: string;
  controlChannelId: string;
  botAdministratorRoleId: string;
  musicControllerRoleId: string;
  restrictedRoleId: string;
  deployedCommandCount: number;
  // True when this run created a new guild profile; false when it resumed an
  // already-configured guild (a no-op re-run), so callers can tell them apart.
  wasFreshSetup: boolean;
}

export interface GuildSetupBotPermissionStatus {
  ok: boolean;
  missing: readonly string[];
}

export interface GuildSetupFeatureState {
  name: GuildFeatureName;
  enabled: boolean;
}

export interface GuildSetupStatus {
  configured: boolean;
  profileFile: string | null;
  controlPanelChannelId: string | null;
  enabledFeatures: readonly string[];
  // Every feature flag (not just the enabled ones), so /setup status can show
  // what's flipped and what's not at a glance instead of only the on set.
  featureStates: readonly GuildSetupFeatureState[];
  access: {
    botAdministrator: ReadonlySet<string>;
    musicController: ReadonlySet<string>;
    restricted: ReadonlySet<string>;
    chatbot: ReadonlySet<string>;
  } | null;
  music: GuildMusicConfiguration | null;
  chat: GuildChatConfiguration | null;
  panel: GuildPanelConfiguration | null;
  botPermissions: GuildSetupBotPermissionStatus;
}

export interface GuildSetupService {
  initialize(request: GuildSetupInitializeRequest): Promise<GuildSetupResult>;
  status(guildId: string): Promise<GuildSetupStatus>;
}

export class DeferredGuildSetupService implements GuildSetupService {
  private service: GuildSetupService | null = null;

  public setService(service: GuildSetupService): void {
    if (this.service) throw new Error("Guild setup service is already initialized.");
    this.service = service;
  }

  public initialize(request: GuildSetupInitializeRequest): Promise<GuildSetupResult> {
    return this.requireService().initialize(request);
  }

  public status(guildId: string): Promise<GuildSetupStatus> {
    return this.requireService().status(guildId);
  }

  private requireService(): GuildSetupService {
    if (!this.service) throw new Error("Guild setup service is not initialized.");
    return this.service;
  }
}
