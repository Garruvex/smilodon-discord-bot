import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type { GuildMemberRegistry } from "../../infrastructure/persistence/guild-member-registry.js";
import type { MemoryEngine } from "../memory/memory.js";

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
    // The unified `memories` table (see memory.ts) has no member_id FK into
    // guild_members — unlike the legacy chat_memories/birthdays/
    // userCustomizations tables it superseded, deleteMember's ON DELETE
    // CASCADE below never reaches it. Owner-scoped memories (private audience,
    // and anything else this user asserted) have to be forgotten explicitly
    // or a retention opt-out silently leaves them behind forever.
    private readonly memoryEngine: MemoryEngine,
  ) {}

  public async handleMemberLeave(guildId: string, userId: string): Promise<void> {
    if (!this.memberRegistry) return;
    const profile = this.guildConfigurationProvider.find(guildId);
    if (profile?.features.retainMemberDataOnLeave !== false) return;
    await this.memberRegistry.deleteMember(guildId, userId);
    await this.memoryEngine.forget({ guildId, ownerUserId: userId });
  }
}
