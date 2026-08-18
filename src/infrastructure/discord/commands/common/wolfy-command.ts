import { EmbedBuilder, SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

const dogNoises = [
  "Woof", "Bark", "Arf", "Ruff", "Bow-wow", "Yip", "Yap", "Howl",
  "Growl", "Snarl", "Baying", "Whine", "Whimper", "Yelp", "Grrr",
] as const;

export class WolfyCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("wolfy")
    .setDescription("Turns a sentence into dog noises.")
    .addStringOption((option) => option.setName("text").setDescription("The sentence to translate.").setMaxLength(1_000).setRequired(true));

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) {
      await context.responses.reply("This only works in a server.");
      return;
    }

    const text = context.interaction.options.getString("text", true).trim();
    if (text.length === 0) {
      await context.responses.reply("You need to provide a sentence to translate.");
      return;
    }

    const dogSentence = text
      .split(" ")
      .map(() => dogNoises[Math.floor(Math.random() * dogNoises.length)]!.toLowerCase())
      .join(" ");

    const embed = new EmbedBuilder()
      .setTitle(dogSentence)
      .setColor("#CC00CC")
      .setFooter({ text: "Woooooooooooof? *waises paw*" })
      .setAuthor({
        name: context.interaction.member.displayName,
        iconURL: context.interaction.user.displayAvatarURL(),
      });
    await context.responses.reply({ embeds: [embed] });
  }
}
