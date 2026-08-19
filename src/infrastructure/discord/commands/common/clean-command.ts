import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

const defaultMessageCount = 100;

export class CleanCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("clean")
    .setDescription("Deletes the bot's recent messages in this channel.")
    .addIntegerOption((option) => option.setName("count").setDescription("How many recent messages to scan (default 100).").setMinValue(2).setMaxValue(100));

  public readonly module = CommandModule.Common;
  public readonly access = {
    ...publicAccessPolicy,
    requiredMemberPermissions: [PermissionFlagsBits.ManageMessages],
    requiredBotPermissions: [PermissionFlagsBits.ManageMessages],
  };

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild() || !context.interaction.channel?.isTextBased()) {
      await context.responses.reply("This only works in a server text channel.");
      return;
    }

    await context.responses.defer();
    const count = context.interaction.options.getInteger("count") ?? defaultMessageCount;
    const channel = context.interaction.channel;
    const botUserId = context.interaction.client.user.id;

    const messages = await channel.messages.fetch({ limit: count });
    const botMessages = messages.filter((message) => message.author.id === botUserId);
    if (botMessages.size === 0) {
      await context.responses.edit("No bot messages found to delete.");
      return;
    }

    const deleted = await channel.bulkDelete(botMessages, true).catch(() => null);
    const deletedCount = deleted?.size ?? 0;
    await context.responses.edit(`Deleted ${deletedCount} bot message${deletedCount === 1 ? "" : "s"}.`);
    context.responses.deleteAfter(5_000);
  }
}
