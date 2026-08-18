import { AttachmentBuilder, EmbedBuilder, SlashCommandBuilder } from "discord.js";

import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

export class QaCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("qa")
    .setDescription("Posts a question-and-answer embed.")
    .addStringOption((option) => option.setName("question").setDescription("The question.").setMaxLength(256).setRequired(true))
    .addStringOption((option) => option.setName("answer").setDescription("The answer.").setMaxLength(1_000).setRequired(true))
    .addAttachmentOption((option) => option.setName("image").setDescription("An image to attach."))
    .addBooleanOption((option) => option.setName("spoiler").setDescription("Hide the answer and image behind a spoiler."));

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;
  public readonly responseVisibility = CommandResponseVisibility.Public;

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) {
      await context.responses.reply("This only works in a server.");
      return;
    }

    const question = context.interaction.options.getString("question", true);
    const answer = context.interaction.options.getString("answer", true);
    const attachment = context.interaction.options.getAttachment("image");
    const isSpoiler = context.interaction.options.getBoolean("spoiler") ?? false;

    if (attachment && !attachment.contentType?.startsWith("image/")) {
      await context.responses.reply("That attachment isn't an image.");
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`Question: ${question.endsWith("?") ? question : `${question}?`}`)
      .setColor("#FF3300")
      .setDescription(`Answer: ${isSpoiler ? `||${answer}||` : answer}`)
      .setAuthor({
        name: context.interaction.member.displayName,
        iconURL: context.interaction.user.displayAvatarURL(),
      });

    await context.responses.reply(attachment
      ? { embeds: [embed], files: [new AttachmentBuilder(attachment.url, { name: isSpoiler ? `SPOILER_${attachment.name}` : attachment.name })] }
      : { embeds: [embed] });
  }
}
