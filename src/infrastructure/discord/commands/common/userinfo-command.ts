import { EmbedBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import type { BoostHistoryStore } from "../../../../application/members/boost-history-store.js";
import { computeTotalBoostedMs, formatDurationMs } from "../../../../application/members/boost-duration.js";

export class UserInfoCommand implements BotCommand {
  public readonly definition = {
    name: "userinfo",
    description: "Shows information about a member.",
    options: [
      { type: "user", name: "user", description: "The member to look up; defaults to you.", required: false },
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;

  public constructor(
    private readonly profiles: GuildConfigurationProvider,
    private readonly boostHistoryStore: BoostHistoryStore,
  ) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) {
      await context.responses.reply("This command is only available in a server.");
      return;
    }

    const guild = context.interaction.guild;
    const targetUser = context.interaction.options.getUser("user") ?? context.interaction.user;
    const member = guild.members.cache.get(targetUser.id)
      ?? await guild.members.fetch(targetUser.id).catch(() => null);
    if (!member) {
      await context.responses.reply("That user is not a member of this server.");
      return;
    }

    const roles = member.roles.cache
      .filter((role) => role.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map((role) => `<@&${role.id}>`);

    const embedColor = this.profiles.find(context.interaction.guildId)?.embedColor as `#${string}` | undefined;
    const embed = new EmbedBuilder()
      .setColor(embedColor ?? "#3B82F6")
      .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
      .setAuthor({ name: targetUser.tag, iconURL: targetUser.displayAvatarURL() })
      .addFields(
        { name: "User", value: `<@${targetUser.id}>\n${targetUser.id}`, inline: true },
        { name: "Bot", value: targetUser.bot ? "Yes" : "No", inline: true },
        { name: "Account created", value: `<t:${Math.floor(targetUser.createdTimestamp / 1_000)}:R>`, inline: true },
        {
          name: "Joined server",
          value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1_000)}:R>` : "Unknown",
          inline: true,
        },
        { name: `Roles (${roles.length})`, value: roles.length > 0 ? roles.join(" ") : "None" },
      );

    if (member.premiumSince) {
      embed.addFields({
        name: "Boosting since",
        value: `<t:${Math.floor(member.premiumSinceTimestamp! / 1_000)}:R>`,
        inline: true,
      });
    }
    const boostEvents = await this.boostHistoryStore.listEvents(guild.id, targetUser.id);
    const totalBoostedMs = computeTotalBoostedMs(boostEvents, member.premiumSince, new Date());
    if (totalBoostedMs > 0) {
      embed.addFields({ name: "Total time boosted", value: formatDurationMs(totalBoostedMs), inline: true });
    }

    await context.responses.reply({ embeds: [embed] });
  }
}
