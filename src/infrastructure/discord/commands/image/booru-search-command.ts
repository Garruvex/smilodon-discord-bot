import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";

import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import { fetchBooruPost } from "../../../booru/booru-client.js";

const videoExtensions = new Set(["webm", "mp4"]);
const maxAttachmentBytes = 24 * 1024 * 1024;

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
    this.definition = {
      name: site,
      description: `Searches for images on ${site}.`,
      nsfw,
      options: [
        {
          type: "string",
          name: "query",
          description: "Tags to search for (e.g. wolf, dragon, solo). Leave empty for a random post.",
        },
        { type: "string", name: "type", description: "File type.", choices: typeChoices },
        { type: "string", name: "order", description: "Sort order.", choices: orderChoices },
      ],
    };
  }

  public async execute(context: CommandContext): Promise<void> {
    await context.responses.defer();
    const query = context.interaction.options.getString("query");
    const type = context.interaction.options.getString("type");
    const order = context.interaction.options.getString("order") ?? "order:random";
    const tags = [query, type, order, "favcount:>100"].filter(Boolean).join(" ");

    try {
      const post = await fetchBooruPost(this.site, tags);
      if (!post || !post.file.url) {
        await context.responses.edit(query ? `No results found for \`${query}\`.` : "No results found.");
        return;
      }

      const postLink = `https://${this.site}.net/posts/${post.id}`;
      const mediaUrl = post.file.url;

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel("View post").setStyle(ButtonStyle.Link).setURL(postLink),
      );

      const caption = `Found Post #${post.id}`;
      const isVideo = videoExtensions.has(post.file.ext.toLowerCase());

      if (post.file.size < maxAttachmentBytes) {
        // A SPOILER_ filename blurs the attachment (and, for images, the embed
        // that references it via attachment://) until clicked — the only
        // reliable way to spoiler media, since Discord won't auto-unfurl a
        // spoiler-wrapped bare link at all.
        const fileName = `${this.nsfw ? "SPOILER_" : ""}${post.id}.${post.file.ext}`;
        const attachment = new AttachmentBuilder(mediaUrl, { name: fileName });
        if (isVideo) {
          // Embeds can't play video, so it has to ride as a bare attachment.
          await context.responses.edit({ content: caption, files: [attachment] });
        } else {
          const mediaEmbed = new EmbedBuilder().setColor(this.embedColor).setTitle(caption).setImage(`attachment://${fileName}`);
          await context.responses.edit({ embeds: [mediaEmbed], files: [attachment] });
        }
      } else {
        // Too large to re-upload — fall back to a bare link (spoilered where
        // possible, though Discord won't preview a spoilered link).
        const linkedMedia = this.nsfw ? `||${mediaUrl}||` : mediaUrl;
        await context.responses.edit(`${caption}\n${linkedMedia}`);
      }

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
