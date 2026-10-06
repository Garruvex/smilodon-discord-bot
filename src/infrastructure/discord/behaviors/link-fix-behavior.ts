import type { Message } from "discord.js";
import type { Logger } from "pino";

import { BehaviorEvent, BehaviorResult, type BotBehavior } from "../../../application/behaviors/behavior.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import type { GuildLinkFixPlatformConfiguration, LinkFixPlatform } from "../../../config/guild-configuration.js";
import { extractLinkRewrites, type LinkRewriteMatch } from "../../../domain/links/link-rewrite.js";
import { isInGameChannel, type IsGameChannel } from "./game-channel-guard.js";

function enabledRewritePlatforms(platforms: GuildLinkFixPlatformConfiguration): ReadonlySet<LinkFixPlatform> {
  return new Set(
    (Object.keys(platforms) as LinkFixPlatform[]).filter((key) => platforms[key]),
  );
}

// Discord caps message content at 2000 characters. A message packed with many
// matched links (spam, a link dump, or just an enthusiastic user) could
// otherwise build a reply that Discord rejects outright — silently dropping
// the fix for every link in it, not just the ones past the limit.
const discordMessageContentMaxChars = 2_000;

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

export class LinkFixBehavior implements BotBehavior<BehaviorEvent.MessageCreated> {
  public readonly id = "link-fix";
  public readonly event = BehaviorEvent.MessageCreated;
  public readonly priority = 50;

  public constructor(
    private readonly profiles: GuildConfigurationProvider,
    private readonly logger: Logger,
    // The narrator owns a D&D game's channels; link fixes stay out of them.
    private readonly isGameChannel: IsGameChannel | null = null,
  ) {}

  public async matches(message: Message): Promise<boolean> {
    if (!message.inGuild() || message.author.bot) return false;
    const profile = this.profiles.find(message.guildId);
    if (!profile?.features.linkFix) return false;
    if (!profile.channels.linkFix.has(message.channelId)) return false;
    const enabledPlatforms = enabledRewritePlatforms(profile.linkFixPlatforms);
    const hasLinks = extractLinkRewrites(message.content, enabledPlatforms).length > 0;
    return hasLinks && !(await isInGameChannel(message, this.isGameChannel));
  }

  public async execute(message: Message): Promise<BehaviorResult> {
    if (!message.inGuild()) return BehaviorResult.Continue;
    const profile = this.profiles.find(message.guildId);
    if (!profile) return BehaviorResult.Continue;
    const enabledPlatforms = enabledRewritePlatforms(profile.linkFixPlatforms);
    const rewrites = extractLinkRewrites(message.content, enabledPlatforms);
    const content = buildRewriteContent(rewrites);
    if (!content) return BehaviorResult.Continue;

    try {
      await message.reply({ content, allowedMentions: { repliedUser: false } });
    } catch (error: unknown) {
      this.logger.warn(
        { error, guildId: message.guildId, channelId: message.channelId, messageId: message.id },
        "Failed to post rewritten link",
      );
      return BehaviorResult.Continue;
    }

    await message.suppressEmbeds(true).catch((error: unknown) => {
      this.logger.warn(
        { error, guildId: message.guildId, channelId: message.channelId, messageId: message.id },
        "Failed to suppress the original message's embed for link fix",
      );
    });

    return BehaviorResult.Continue;
  }
}
