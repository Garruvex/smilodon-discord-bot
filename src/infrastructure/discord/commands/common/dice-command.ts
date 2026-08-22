import { EmbedBuilder } from "discord.js";

import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import { rollDice } from "../../../../domain/games/dice.js";

const diceFaces = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"] as const;

// The die-face pip glyphs (U+2680-2685) aren't part of the official Unicode
// Emoji set, so no emoji-art library (Twemoji, OpenMoji, etc.) has images for
// them. Keycap number emoji (1-6) are real emoji with real art, so those are
// used to represent the rolled value as an image instead.
function diceFaceImageUrl(roll: number): string {
  const codepoint = (0x30 + roll).toString(16);
  return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/72x72/${codepoint}-20e3.png`;
}

const maxImageDice = 10;

export class DiceCommand implements BotCommand {
  public readonly definition = {
    name: "dice",
    description: "Rolls one or more dice.",
    options: [
      { type: "integer", name: "sides", description: "Number of sides per die (default 6).", minValue: 2, maxValue: 1_000 },
      { type: "integer", name: "count", description: "Number of dice to roll (default 1).", minValue: 1, maxValue: 20 },
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;
  public readonly responseVisibility = CommandResponseVisibility.Public;

  public async execute(context: CommandContext): Promise<void> {
    const sides = context.interaction.options.getInteger("sides") ?? 6;
    const count = context.interaction.options.getInteger("count") ?? 1;

    const { rolls, total } = rollDice(sides, count);

    const footerText = count === 1 ? `d${sides}` : `${count}d${sides} — total ${total}`;

    if (sides === 6 && count <= maxImageDice) {
      const embeds = rolls.map((roll, index) => {
        const embed = new EmbedBuilder().setImage(diceFaceImageUrl(roll));
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
