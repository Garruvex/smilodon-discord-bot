import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type { MemberDataPurger } from "./member-data-purger.js";

// Reacts to a member leaving a guild. Deletes their private, user-owned data
// only when the guild has explicitly opted out of retention
// (features.retainMemberDataOnLeave === false). Shared guild/channel memories
// remain community history; the default keeps everything for returning users.
export class MemberDepartureService {
  public constructor(
    private readonly guildConfigurationProvider: GuildConfigurationProvider,
    private readonly memberDataPurger: MemberDataPurger,
  ) {}

  public async handleMemberLeave(guildId: string, userId: string): Promise<void> {
    const profile = this.guildConfigurationProvider.find(guildId);
    if (profile?.features.retainMemberDataOnLeave !== false) return;
    await this.memberDataPurger.purge(guildId, userId);
  }
}
