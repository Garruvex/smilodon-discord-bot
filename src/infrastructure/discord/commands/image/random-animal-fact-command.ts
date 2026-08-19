import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { z } from "zod";

import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

const responseSchema = z.object({ image: z.string().url(), fact: z.string() });

export class RandomAnimalFactCommand implements BotCommand {
  public readonly definition: BotCommand["definition"];
  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;
  public readonly responseVisibility = CommandResponseVisibility.Public;

  public constructor(
    private readonly species: string,
    private readonly emoji: string,
    private readonly footer: string,
  ) {
    this.definition = new SlashCommandBuilder()
      .setName(species)
      .setDescription(`Gets a random ${species} image and fact.`);
  }

  public async execute(context: CommandContext): Promise<void> {
    await context.responses.defer();
    try {
      const response = await fetch(`https://some-random-api.com/animal/${this.species}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = responseSchema.parse(await response.json());
      const embed = new EmbedBuilder()
        .setTitle(this.emoji)
        .setImage(data.image)
        .setDescription(`Fact: ${data.fact}`)
        .setFooter({ text: this.footer });
      await context.responses.edit({ embeds: [embed] });
    } catch (error) {
      context.logger.warn({ error, species: this.species }, "Random animal fact request failed");
      await context.responses.edit("Couldn't fetch an image right now. Try again in a moment.");
    }
  }
}
