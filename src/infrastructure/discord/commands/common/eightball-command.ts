import { EmbedBuilder } from "discord.js";

import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import { pickEightBallAnswer } from "../../../../domain/games/eightball.js";

const eightBallImageUrl = "https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/72x72/1f3b1.png";

export class EightBallCommand implements BotCommand {
  public readonly definition = {
    name: "8ball",
    description: "Ask the magic 8-ball a question.",
    options: [
      { type: "string", name: "question", description: "What do you want to ask?", maxLength: 500, required: true },
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;
  public readonly responseVisibility = CommandResponseVisibility.Public;

  public async execute(context: CommandContext): Promise<void> {
    const question = context.interaction.options.getString("question", true);
    const answer = pickEightBallAnswer();

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
