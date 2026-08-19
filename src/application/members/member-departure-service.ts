import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type { GuildMemberRegistry } from "../../infrastructure/persistence/guild-member-registry.js";

// Reacts to a member leaving a guild. Deletes their chat memories/birthday/
// customization only when the guild has explicitly opted out of retention
// (features.retainMemberDataOnLeave === false); the default is to keep the
// data so a returning member doesn't lose their whole relationship with the
// bot. No-ops entirely on the local (file-based) backend, which has no
// guild_members hub to cascade from.
export class MemberDepartureService {
  public constructor(
    private readonly guildConfigurationProvider: GuildConfigurationProvider,
    private readonly memberRegistry: GuildMemberRegistry | null,
  ) {}

  public async handleMemberLeave(guildId: string, userId: string): Promise<void> {
    if (!this.memberRegistry) return;
    const profile = this.guildConfigurationProvider.find(guildId);
    if (profile?.features.retainMemberDataOnLeave !== false) return;
    await this.memberRegistry.deleteMember(guildId, userId);
  }
}
