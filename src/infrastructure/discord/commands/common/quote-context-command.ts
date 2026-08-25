import { AttachmentBuilder, MessageFlags, type MessageContextMenuCommandInteraction } from "discord.js";

import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import { getQuoteText, renderQuoteCard } from "./quote-card-renderer.js";

export class QuoteContextCommand implements BotCommand<MessageContextMenuCommandInteraction> {
  public readonly definition = {
    type: "messageContextMenu",
    name: "Quote",
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;
  public readonly responseVisibility = CommandResponseVisibility.Public;

  public async execute(context: CommandContext<MessageContextMenuCommandInteraction>): Promise<void> {
    const targetMessage = context.interaction.targetMessage;

    // Checked before deferring so this can stay a private, ephemeral reply —
    // once deferred with the command's public visibility, a reply can no
    // longer be made ephemeral.
    if (!getQuoteText(targetMessage)) {
      await context.interaction.reply({
        content: "That message has no text to quote.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await context.responses.defer();
    const buffer = await renderQuoteCard(targetMessage, context.interaction.client.user.username);
    const attachment = new AttachmentBuilder(buffer, { name: "quote.png" });
    await context.responses.edit({ files: [attachment] });
  }
}
