import type { GuildSetupBotPermissionStatus } from "./guild-setup-service.js";

export interface GuildRoleHandle {
  id: string;
}

export interface GuildChannelHandle {
  id: string;
}

// Discord-independent port for the guild resources LocalGuildSetupService
// creates, deletes, and inspects during /setup initialize and /setup status.
// The `reason` on each mutating call is an audit-log entry, chosen by the
// application-layer caller (it knows *why*); the gateway just executes it.
export interface GuildResourceGateway {
  createRole(guildId: string, name: string, reason: string): Promise<GuildRoleHandle>;
  deleteRole(guildId: string, roleId: string, reason: string): Promise<void>;
  createTextChannel(guildId: string, name: string, topic: string, reason: string): Promise<GuildChannelHandle>;
  deleteChannel(guildId: string, channelId: string, reason: string): Promise<void>;
  // Null when the channel doesn't exist or isn't a guild text channel.
  fetchTextChannel(guildId: string, channelId: string): Promise<GuildChannelHandle | null>;
  // No-op if the member already has the role.
  grantRoleIfMissing(guildId: string, memberId: string, roleId: string, reason: string): Promise<void>;
  checkBotPermissions(guildId: string): Promise<GuildSetupBotPermissionStatus>;
}
