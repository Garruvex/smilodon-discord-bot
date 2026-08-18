import type { Message } from "discord.js";
import type { Logger } from "pino";

import { BehaviorEvent, BehaviorResult, type BotBehavior } from "../../../application/behaviors/behavior.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { extractLinkRewrites } from "../../../domain/links/link-rewrite.js";

export class LinkFixBehavior implements BotBehavior<Message> {
  public readonly id = "link-fix";
  public readonly event = BehaviorEvent.MessageCreated;
  public readonly priority = 50;

  public constructor(
    private readonly profiles: GuildConfigurationProvider,
    private readonly logger: Logger,
  ) {}

  public matches(message: Message): Promise<boolean> {
    if (!message.inGuild() || message.author.bot) return Promise.resolve(false);
    const profile = this.profiles.find(message.guildId);
    if (!profile?.features.linkFix) return Promise.resolve(false);
    if (!profile.channels.linkFix.has(message.channelId)) return Promise.resolve(false);
    return Promise.resolve(extractLinkRewrites(message.content).length > 0);
  }

  public async execute(message: Message): Promise<BehaviorResult> {
    const rewrites = extractLinkRewrites(message.content);
    if (rewrites.length === 0) return BehaviorResult.Continue;

    await message.suppressEmbeds(true).catch((error: unknown) => {
      this.logger.warn(
        { error, guildId: message.guildId, channelId: message.channelId, messageId: message.id },
        "Failed to suppress the original message's embed for link fix",
      );
    });

    const content = rewrites.map((rewrite) => rewrite.rewrittenUrl).join("\n");
    await message.reply({
      content,
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
