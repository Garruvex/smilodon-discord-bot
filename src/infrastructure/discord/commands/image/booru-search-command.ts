import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { z } from "zod";

import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

const postSchema = z.object({
  id: z.number(),
  score: z.object({ up: z.number() }),
  fav_count: z.number(),
  rating: z.string(),
  file: z.object({ url: z.string().url().nullable() }),
  tags: z.object({
    artist: z.array(z.string()).default([]),
    species: z.array(z.string()).default([]),
  }),
});
const responseSchema = z.object({ posts: z.array(postSchema) });

const typeChoices = [
  { name: "GIF", value: "type:gif" },
  { name: "Video", value: "type:webm" },
  { name: "Static image", value: "-type:gif -type:webm" },
] as const;
const orderChoices = [
  { name: "Random", value: "order:random" },
  { name: "Latest", value: "order:id" },
  { name: "Most liked", value: "order:favcount" },
  { name: "Highest score", value: "order:score" },
] as const;

export class BooruSearchCommand implements BotCommand {
  public readonly definition: BotCommand["definition"];
  public readonly module: CommandModule;
  public readonly access = publicAccessPolicy;
  public readonly responseVisibility = CommandResponseVisibility.Public;

  public constructor(
    private readonly site: "e621" | "e926",
    private readonly embedColor: `#${string}`,
    private readonly nsfw: boolean,
  ) {
    this.module = nsfw ? CommandModule.Nsfw : CommandModule.Common;
    this.definition = new SlashCommandBuilder()
      .setName(site)
      .setDescription(`Searches for images on ${site}.`)
      .setNSFW(nsfw)
      .addStringOption((option) => option.setName("query").setDescription("Tags to search for (e.g. wolf, dragon, solo).").setRequired(true))
      .addStringOption((option) => option.setName("type").setDescription("File type.").addChoices(...typeChoices))
      .addStringOption((option) => option.setName("order").setDescription("Sort order.").addChoices(...orderChoices));
  }

  public async execute(context: CommandContext): Promise<void> {
    await context.responses.defer();
    const query = context.interaction.options.getString("query", true);
    const type = context.interaction.options.getString("type");
    const order = context.interaction.options.getString("order") ?? "order:random";
    const tags = [query, type, order, "favcount:>100"].filter(Boolean).join(" ");

    try {
      const response = await fetch(`https://${this.site}.net/posts.json?tags=${encodeURIComponent(tags)}&limit=1`, {
        headers: { "User-Agent": "FNTU-Discord-Bot/1.0 (+https://github.com/)" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = responseSchema.parse(await response.json());
      const post = data.posts[0];
      if (!post || !post.file.url) {
        await context.responses.edit(`No results found for \`${query}\`.`);
        return;
      }

      const postLink = `https://${this.site}.net/posts/${post.id}`;
      const mediaUrl = post.file.url;

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel("View post").setStyle(ButtonStyle.Link).setURL(postLink),
      );

      // A bare URL (not a markdown link, and not inside an EmbedBuilder embed) lets
      // Discord auto-generate its own preview — the only way to get a playable
      // video preview, and the only way to get a spoilered/blurred preview.
      const linkedMedia = this.nsfw ? `||${mediaUrl}||` : mediaUrl;
      await context.responses.edit(`Found Post #${post.id}\n${linkedMedia}`);

      const embed = new EmbedBuilder()
        .setColor(this.embedColor)
        .setDescription(
          [
            `Artist: ${post.tags.artist.join(", ") || "unknown"} · Species: ${post.tags.species.join(", ") || "unknown"}`,
            `Score: ${post.score.up} · Favorites: ${post.fav_count} · Rating: ${post.rating.toUpperCase()}`,
          ].join("\n"),
        );
      await context.interaction.followUp({ embeds: [embed], components: [row] });
    } catch (error) {
      context.logger.warn({ error, site: this.site, query }, "Booru search request failed");
      await context.responses.edit("Couldn't complete that search right now. Try again in a moment.");
    }
  }
}
