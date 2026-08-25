import { AttachmentBuilder } from "discord.js";

import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import { getQuoteText, renderQuoteCard } from "./quote-card-renderer.js";

const messageLinkPattern = /^https:\/\/(?:canary\.|ptb\.)?discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)$/;

export class QuoteCommand implements BotCommand {
  public readonly definition = {
    name: "quote",
    description: "Turn a message into a quote card.",
    options: [
      {
        type: "string",
        name: "message",
        description: "A message link, or a message ID from this channel.",
        required: true,
      },
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;
  // Kept ephemeral: the deferred reply has to commit to a visibility before
  // fetching the target message, and error paths (bad link, empty message)
  // should stay private. A successful quote card is posted publicly as a
  // separate follow-up instead — see the end of execute().
  public readonly responseVisibility = CommandResponseVisibility.Ephemeral;

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild() || !context.interaction.channel?.isTextBased()) {
      await context.responses.reply("This only works in a server text channel.");
      return;
    }

    await context.responses.defer();

    const input = context.interaction.options.getString("message", true).trim();
    const linkMatch = messageLinkPattern.exec(input);

    let targetChannel = context.interaction.channel;
    let messageId = input;

    if (linkMatch) {
      const [, guildId, channelId, id] = linkMatch as unknown as [string, string, string, string];
      if (guildId !== context.interaction.guildId) {
        await context.responses.edit("That message link is from a different server.");
        return;
      }
      const linkedChannel = await context.interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!linkedChannel?.isTextBased()) {
        await context.responses.edit("Couldn't find that message's channel.");
        return;
      }
      targetChannel = linkedChannel;
      messageId = id;
    }

    const targetMessage = await targetChannel.messages.fetch(messageId).catch(() => null);
    if (!targetMessage) {
      await context.responses.edit("Couldn't find that message. Check the link or ID and try again.");
      return;
    }

    if (!getQuoteText(targetMessage)) {
      await context.responses.edit("That message has no text to quote.");
      return;
    }

    const buffer = await renderQuoteCard(targetMessage, context.interaction.client.user.username);
    const attachment = new AttachmentBuilder(buffer, { name: "quote.png" });
    await context.interaction.followUp({ files: [attachment] });
    await context.interaction.deleteReply().catch(() => undefined);
  }
}
