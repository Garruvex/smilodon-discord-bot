import { AttachmentBuilder, type GuildMember, type PartialGuildMember } from "discord.js";
import type { Logger } from "pino";

import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import { renderWelcomeCard } from "../../infrastructure/discord/members/welcome-card-renderer.js";

// Two independent, optional channels — no separate enabled/disabled flag.
// An unset channel simply means that event doesn't notify; presence of the
// channel id is the entire gate. Neither join nor leave is a slash command,
// so there's no CommandModule feature-gating concern the way birthdays/
// reminders have.
export class MemberWelcomeService {
  public constructor(
    private readonly guildConfigurationProvider: GuildConfigurationProvider,
    private readonly logger: Logger,
  ) {}

  public async handleMemberJoin(member: GuildMember): Promise<void> {
    const channelId = this.guildConfigurationProvider.find(member.guild.id)?.channels.joinAnnouncements;
    if (!channelId) return;

    const channel = await member.guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) {
      this.logger.warn(
        { guildId: member.guild.id, channelId },
        "Join announcement channel is not a usable text channel",
      );
      return;
    }

    try {
      const buffer = await renderWelcomeCard(member);
      const attachment = new AttachmentBuilder(buffer, { name: "welcome.png" });
      await channel.send({ files: [attachment] });
    } catch (error) {
      this.logger.error({ error, guildId: member.guild.id, userId: member.id }, "Welcome card failed");
    }
  }

  public async handleMemberLeave(member: GuildMember | PartialGuildMember): Promise<void> {
    const channelId = this.guildConfigurationProvider.find(member.guild.id)?.channels.leaveAnnouncements;
    if (!channelId) return;

    const channel = await member.guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) {
      this.logger.warn(
        { guildId: member.guild.id, channelId },
        "Leave announcement channel is not a usable text channel",
      );
      return;
    }

    const tag = member.user?.tag ?? member.id;
    try {
      await channel.send(`👋 **${tag}** has left the server.`);
    } catch (error) {
      this.logger.error({ error, guildId: member.guild.id, userId: member.id }, "Leave announcement failed");
    }
  }
}
