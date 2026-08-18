import { EmbedBuilder, SlashCommandBuilder } from "discord.js";

import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

const eightBallImageUrl = "https://twemoji.maxcdn.com/v/latest/72x72/1f3b1.png";

const answers = [
  "It is certain.",
  "It is decidedly so.",
  "Without a doubt.",
  "Yes, definitely.",
  "You may rely on it.",
  "As I see it, yes.",
  "Most likely.",
  "Outlook good.",
  "Yes.",
  "Signs point to yes.",
  "Reply hazy, try again.",
  "Ask again later.",
  "Better not tell you now.",
  "Cannot predict now.",
  "Concentrate and ask again.",
  "Don't count on it.",
  "My reply is no.",
  "My sources say no.",
  "Outlook not so good.",
  "Very doubtful.",
] as const;

export class EightBallCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("8ball")
    .setDescription("Ask the magic 8-ball a question.")
    .addStringOption((option) => option
      .setName("question")
      .setDescription("What do you want to ask?")
      .setMaxLength(500)
      .setRequired(true));

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;
  public readonly responseVisibility = CommandResponseVisibility.Public;

  public async execute(context: CommandContext): Promise<void> {
    const question = context.interaction.options.getString("question", true);
    const answer = answers[Math.floor(Math.random() * answers.length)];

    const embed = new EmbedBuilder()
      .setColor("#1A1A1A")
      .setAuthor({ name: "Magic 8-Ball", iconURL: eightBallImageUrl })
      .addFields(
        { name: "Question", value: question },
        { name: "Answer", value: `**${answer}**` },
      );

    await context.responses.reply({ embeds: [embed] });
  }
}
