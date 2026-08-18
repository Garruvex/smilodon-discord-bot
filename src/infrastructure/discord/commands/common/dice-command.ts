import { EmbedBuilder, SlashCommandBuilder } from "discord.js";

import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

const diceFaces = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"] as const;
const diceFaceCodepoints = ["2680", "2681", "2682", "2683", "2684", "2685"] as const;

function diceFaceImageUrl(roll: number): string {
  return `https://twemoji.maxcdn.com/v/latest/72x72/${diceFaceCodepoints[roll - 1]}.png`;
}

// Discord groups embeds that share the same `url` into an image gallery
// within a single message. This is used to show each die face as a real
// image without compositing them into one picture ourselves.
const galleryAnchorUrl = "https://dice-roll.invalid";
const maxGalleryDice = 10;

export class DiceCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("dice")
    .setDescription("Rolls one or more dice.")
    .addIntegerOption((option) => option
      .setName("sides")
      .setDescription("Number of sides per die (default 6).")
      .setMinValue(2)
      .setMaxValue(1_000))
    .addIntegerOption((option) => option
      .setName("count")
      .setDescription("Number of dice to roll (default 1).")
      .setMinValue(1)
      .setMaxValue(20));

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;
  public readonly responseVisibility = CommandResponseVisibility.Public;

  public async execute(context: CommandContext): Promise<void> {
    const sides = context.interaction.options.getInteger("sides") ?? 6;
    const count = context.interaction.options.getInteger("count") ?? 1;

    const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
    const total = rolls.reduce((sum, roll) => sum + roll, 0);

    const footerText = count === 1 ? `d${sides}` : `${count}d${sides} — total ${total}`;

    if (sides === 6 && count <= maxGalleryDice) {
      const embeds = rolls.map((roll, index) => {
        const embed = new EmbedBuilder()
          .setURL(galleryAnchorUrl)
          .setImage(diceFaceImageUrl(roll));
        if (index === 0) embed.setTitle("🎲 Dice roll").setFooter({ text: footerText });
        return embed;
      });
      await context.responses.reply({ embeds });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("🎲 Dice roll")
      .setFooter({ text: footerText })
      .setDescription(sides === 6
        ? rolls.map((roll) => diceFaces[roll - 1]).join("  ")
        : rolls.join(", "));

    await context.responses.reply({ embeds: [embed] });
  }
}
