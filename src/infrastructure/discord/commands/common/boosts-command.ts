import { MessageFlags } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { BoostHistoryStore } from "../../../../application/members/boost-history-store.js";
import { computeTotalBoostedMs, formatDurationMs } from "../../../../application/members/boost-duration.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

export class BoostsCommand implements BotCommand {
  public readonly definition = {
    name: "boosts",
    description: "Shows server boost history.",
    subcommands: [
      {
        name: "history",
        description: "Shows a member's boost timeline and total time boosted.",
        options: [
          { type: "user", name: "user", description: "The member to look up; defaults to you.", required: false },
        ],
      },
      {
        name: "leaderboard",
        description: "Shows the server's current boosters, longest streak first.",
        options: [
          { type: "boolean", name: "public", description: "Show this to everyone instead of just you.", required: false },
        ],
      },
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;

  public constructor(private readonly boostHistoryStore: BoostHistoryStore) {}

  private async replyPrivately(context: CommandContext, content: string): Promise<void> {
    await context.responses.reply({ content, flags: MessageFlags.Ephemeral });
  }

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) {
      await this.replyPrivately(context, "This only works in a server.");
      return;
    }
    const guild = context.interaction.guild;
    const subcommand = context.interaction.options.getSubcommand(true);

    if (subcommand === "leaderboard") {
      const isPublic = context.interaction.options.getBoolean("public") ?? false;
      const members = await guild.members.fetch();
      const boosters = members
        .filter((member) => member.premiumSince !== null)
        .sort((a, b) => a.premiumSinceTimestamp! - b.premiumSinceTimestamp!);

      if (boosters.size === 0) {
        await context.responses.reply({
          content: "No one is currently boosting this server.",
          flags: isPublic ? undefined : MessageFlags.Ephemeral,
        });
        return;
      }

      const lines = boosters.first(10).map((member, index) =>
        `${index + 1}. <@${member.id}> — boosting since <t:${Math.floor(member.premiumSinceTimestamp! / 1_000)}:D>`,
      );
      await context.responses.reply({
        content: `💎 **Current boosters (longest streak first)**\n${lines.join("\n")}`,
        flags: isPublic ? undefined : MessageFlags.Ephemeral,
      });
      return;
    }

    const targetUser = context.interaction.options.getUser("user") ?? context.interaction.user;
    const member = guild.members.cache.get(targetUser.id)
      ?? await guild.members.fetch(targetUser.id).catch(() => null);
    if (!member) {
      await this.replyPrivately(context, "That user is not a member of this server.");
      return;
    }

    const events = await this.boostHistoryStore.listEvents(guild.id, targetUser.id);
    const totalBoostedMs = computeTotalBoostedMs(events, member.premiumSince, new Date());

    if (events.length === 0 && !member.premiumSince) {
      await this.replyPrivately(
        context,
        targetUser.id === context.interaction.user.id
          ? "You haven't boosted this server (that we've tracked)."
          : `<@${targetUser.id}> hasn't boosted this server (that we've tracked).`,
      );
      return;
    }

    const timelineLines = events.map((event) =>
      `${event.eventType === "started" ? "🟢 Started" : "🔴 Ended"} boosting <t:${Math.floor(event.occurredAt.getTime() / 1_000)}:D>`,
    );
    if (member.premiumSince && !events.some((event) => event.eventType === "started" && event.occurredAt.getTime() === member.premiumSinceTimestamp)) {
      timelineLines.push(`🟢 Started boosting <t:${Math.floor(member.premiumSinceTimestamp! / 1_000)}:D> (currently boosting)`);
    }

    await this.replyPrivately(
      context,
      `**<@${targetUser.id}>'s boost history**\n${timelineLines.join("\n")}\n\nTotal time boosted: ${formatDurationMs(totalBoostedMs)}`,
    );
  }
}
