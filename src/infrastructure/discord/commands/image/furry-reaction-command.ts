import { EmbedBuilder } from "discord.js";
import { z } from "zod";

import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

const responseSchema = z.object({ images: z.array(z.object({ url: z.string().url() })).min(1) });

export class FurryReactionCommand implements BotCommand {
  public readonly definition: BotCommand["definition"];
  public readonly module: CommandModule;
  public readonly access = publicAccessPolicy;
  public readonly responseVisibility = CommandResponseVisibility.Public;

  public constructor(
    private readonly key: string,
    description: string,
    private readonly title: string,
    private readonly reactionText: string,
    private readonly footer: string,
    nsfw: boolean,
  ) {
    this.module = nsfw ? CommandModule.Nsfw : CommandModule.Common;
    this.definition = {
      name: key,
      description,
      nsfw,
    };
  }

  public async execute(context: CommandContext): Promise<void> {
    await context.responses.defer();
    try {
      const response = await fetch(`https://v2.yiff.rest/furry/${this.key}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = responseSchema.parse(await response.json());
      const embed = new EmbedBuilder()
        .setTitle(this.title)
        .setImage(data.images[0]!.url)
        .setDescription(this.reactionText)
        .setFooter({ text: this.footer });
      await context.responses.edit({ embeds: [embed] });
    } catch (error) {
      context.logger.warn({ error, key: this.key }, "Furry reaction image request failed");
      await context.responses.edit("Couldn't fetch an image right now. Try again in a moment.");
    }
  }
}
