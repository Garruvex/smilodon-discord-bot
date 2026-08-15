import type { Guild, GuildMember, Role, TextChannel } from "discord.js";

export interface GuildSetupInitializeRequest {
  guild: Guild;
  initializedBy: GuildMember;
  displayName: string;
  idleImageUrl: string | null;
  controlChannel: TextChannel | null;
  botAdministratorRole: Role | null;
  musicControllerRole: Role | null;
  restrictedRole: Role | null;
}

export interface GuildSetupResult {
  guildId: string;
  controlChannelId: string;
  botAdministratorRoleId: string;
  musicControllerRoleId: string;
  restrictedRoleId: string;
  deployedCommandCount: number;
}

export interface GuildSetupStatus {
  configured: boolean;
  profileFile: string | null;
  controlPanelChannelId: string | null;
  enabledFeatures: readonly string[];
  access: {
    botAdministrator: ReadonlySet<string>;
    musicController: ReadonlySet<string>;
    restricted: ReadonlySet<string>;
    chatbot: ReadonlySet<string>;
  } | null;
}

export interface GuildSetupService {
  initialize(request: GuildSetupInitializeRequest): Promise<GuildSetupResult>;
  status(guildId: string): GuildSetupStatus;
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

  public status(guildId: string): GuildSetupStatus {
    return this.requireService().status(guildId);
  }

  private requireService(): GuildSetupService {
    if (!this.service) throw new Error("Guild setup service is not initialized.");
    return this.service;
  }
}
