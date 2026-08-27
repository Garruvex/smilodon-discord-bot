import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type { MemberDataPurger } from "./member-data-purger.js";

// Reacts to a member leaving a guild. Deletes their chat memories/birthday/
// customization/reminders only when the guild has explicitly opted out of
// retention (features.retainMemberDataOnLeave === false); the default is to
// keep the data so a returning member doesn't lose their whole relationship
// with the bot.
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
