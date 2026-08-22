import { EmbedBuilder } from "discord.js";
import { z } from "zod";

import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

// Uses FurTrack's internal "solar" API directly (the same one the unofficial
// furtrack-api npm package calls) rather than scraping the SPA frontend, which
// avoids a headless-browser dependency. This is not a documented public API,
// so it may break without notice if FurTrack changes their backend.
const defaultTag = "fursuit";
const maxAttempts = 3;
const requestHeaders = {
  "User-Agent": "Mozilla/5.0 (compatible; FNTU-Discord-Bot/1.0)",
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.furtrack.com/",
  Origin: "https://www.furtrack.com",
};

const listingSchema = z.object({
  success: z.boolean(),
  posts: z.array(z.object({ postId: z.number() })).default([]),
});

const postResponseSchema = z.object({
  success: z.boolean(),
  post: z.object({
    postId: z.number(),
    postAdult: z.number(),
    submitUserId: z.number(),
    submitUsername: z.string(),
    taken: z.string().nullable(),
    metaFingerprint: z.string(),
    metaFiletype: z.string(),
  }).optional(),
});

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

export class FursuitFurtrackCommand implements BotCommand {
  public readonly definition = {
    name: "fursuit-furtrack",
    description: "Gets a random fursuit photo from furtrack.com.",
    options: [
      {
        type: "string",
        name: "tag",
        description: "Tag to search for (default: fursuit).",
        maxLength: 100,
      },
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;
  public readonly responseVisibility = CommandResponseVisibility.Public;

  public async execute(context: CommandContext): Promise<void> {
    await context.responses.defer();
    const tag = context.interaction.options.getString("tag")?.trim() || defaultTag;

    try {
      const listingResponse = await fetch(`https://solar.furtrack.com/view/index/${encodeURIComponent(tag)}`, {
        headers: requestHeaders,
        signal: AbortSignal.timeout(10_000),
      });
      if (!listingResponse.ok) throw new Error(`HTTP ${listingResponse.status}`);
      const listing = listingSchema.parse(await listingResponse.json());

      if (!listing.success || listing.posts.length === 0) {
        await context.responses.edit(`No FurTrack results found for \`${tag}\`.`);
        return;
      }

      const candidates = shuffled(listing.posts).slice(0, maxAttempts);
      for (const candidate of candidates) {
        const response = await fetch(`https://solar.furtrack.com/view/post/${candidate.postId}`, {
          headers: requestHeaders,
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) continue;
        const parsed = postResponseSchema.parse(await response.json());
        if (!parsed.success || !parsed.post || parsed.post.postAdult !== 0) continue;

        const post = parsed.post;
        const imageUrl = `https://orca2.furtrack.com/gallery/${post.submitUserId}/${post.postId}-${post.metaFingerprint}.${post.metaFiletype}`;
        const postLink = `https://www.furtrack.com/p/${post.postId}`;
        const embed = new EmbedBuilder()
          .setTitle(`Fursuit photo — "${tag}"`)
          .setImage(imageUrl)
          .setAuthor({ name: "furtrack.com", iconURL: "https://orca2.furtrack.com/assets/img/logomark-small.png" })
          .setDescription(`Photo by: ${post.submitUsername}${post.taken ? ` | ${post.taken.slice(0, 10)}` : ""}`)
          .setFooter({ text: `visit -> ${postLink}` });
        await context.responses.edit({ embeds: [embed] });
        return;
      }

      await context.responses.edit(`Found results for \`${tag}\`, but couldn't get a safe one right now. Try again.`);
    } catch (error) {
      context.logger.warn({ error, tag }, "FurTrack search failed");
      await context.responses.edit("Couldn't fetch a fursuit photo right now. Try again in a moment.");
    }
  }
}
