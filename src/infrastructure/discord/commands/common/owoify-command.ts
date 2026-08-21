import { EmbedBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { owoify } from "../../../../application/text/owoifier.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

export class OwoifyCommand implements BotCommand {
  public readonly definition = {
    name: "owoify",
    description: "Twanswates a sentence into owo speak.",
    options: [
      { type: "string", name: "text", description: "The sentence to owoify.", maxLength: 1_000, required: true },
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) {
      await context.responses.reply("This only works in a server.");
      return;
    }

    const text = context.interaction.options.getString("text", true).trim();
    if (text.length === 0) {
      await context.responses.reply("You need to provide a sentence to owoify.");
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(owoify(text))
      .setColor("#FFBDDE")
      .setFooter({ text: "Powew B-By OwO! *nuzzles*" })
      .setAuthor({
        name: context.interaction.member.displayName,
        iconURL: context.interaction.user.displayAvatarURL(),
      });
    await context.responses.reply({ embeds: [embed] });
  }
}
