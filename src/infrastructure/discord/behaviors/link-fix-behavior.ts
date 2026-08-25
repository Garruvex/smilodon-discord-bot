import type { EmbedBuilder, Message } from "discord.js";
import type { Logger } from "pino";

import { BehaviorEvent, BehaviorResult, type BotBehavior } from "../../../application/behaviors/behavior.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { extractBilibiliLinks } from "../../../domain/links/bilibili-link.js";
import { extractLinkRewrites, type LinkRewriteMatch } from "../../../domain/links/link-rewrite.js";
import type { BilibiliEmbedService } from "../../links/bilibili-embed-service.js";

// Discord hard limits: message content is capped at 2000 characters, and a
// single message can carry at most 10 embeds. A message packed with many
// matched links (spam, a link dump, or just an enthusiastic user) could
// otherwise build a reply that Discord rejects outright — silently dropping
// the fix for every link in it, not just the ones past the limit.
const discordMessageContentMaxChars = 2_000;
const discordMaxEmbedsPerMessage = 10;

// Keeps whole rewritten URLs (never truncates one mid-string) and stops
// once adding the next line — including its joining newline — would push
// past Discord's content cap.
function buildRewriteContent(rewrites: readonly LinkRewriteMatch[]): string | null {
  if (rewrites.length === 0) return null;
  let content = "";
  for (const rewrite of rewrites) {
    const line = content.length === 0 ? rewrite.rewrittenUrl : `\n${rewrite.rewrittenUrl}`;
    if (content.length + line.length > discordMessageContentMaxChars) break;
    content += line;
  }
  return content.length > 0 ? content : null;
}

export class LinkFixBehavior implements BotBehavior<Message> {
  public readonly id = "link-fix";
  public readonly event = BehaviorEvent.MessageCreated;
  public readonly priority = 50;

  public constructor(
    private readonly profiles: GuildConfigurationProvider,
    private readonly bilibiliEmbeds: BilibiliEmbedService,
    private readonly logger: Logger,
  ) {}

  public matches(message: Message): Promise<boolean> {
    if (!message.inGuild() || message.author.bot) return Promise.resolve(false);
    const profile = this.profiles.find(message.guildId);
    if (!profile?.features.linkFix) return Promise.resolve(false);
    if (!profile.channels.linkFix.has(message.channelId)) return Promise.resolve(false);
    return Promise.resolve(
      extractLinkRewrites(message.content).length > 0 ||
      extractBilibiliLinks(message.content).length > 0,
    );
  }

  public async execute(message: Message): Promise<BehaviorResult> {
    const rewrites = extractLinkRewrites(message.content);
    const bilibiliLinks = extractBilibiliLinks(message.content);
    if (rewrites.length === 0 && bilibiliLinks.length === 0) return BehaviorResult.Continue;

    // Cap before fetching, not just before sending — no point building an
    // embed Discord will reject the whole message over.
    const bilibiliEmbeds = (await Promise.all(
      bilibiliLinks.slice(0, discordMaxEmbedsPerMessage).map((link) => this.bilibiliEmbeds.buildEmbed(link).catch((error: unknown) => {
        this.logger.warn(
          { error, guildId: message.guildId, channelId: message.channelId, messageId: message.id },
          "Failed to build Bilibili embed",
        );
        return null;
      })),
    )).filter((embed): embed is EmbedBuilder => embed !== null);

    if (rewrites.length === 0 && bilibiliEmbeds.length === 0) return BehaviorResult.Continue;

    await message.suppressEmbeds(true).catch((error: unknown) => {
      this.logger.warn(
        { error, guildId: message.guildId, channelId: message.channelId, messageId: message.id },
        "Failed to suppress the original message's embed for link fix",
      );
    });

    const content = buildRewriteContent(rewrites);
    await message.reply({
      ...(content ? { content } : {}),
      embeds: bilibiliEmbeds,
      allowedMentions: { repliedUser: false },
    }).catch((error: unknown) => {
      this.logger.warn(
        { error, guildId: message.guildId, channelId: message.channelId, messageId: message.id },
        "Failed to post rewritten link",
      );
    });

    return BehaviorResult.Continue;
  }
}
