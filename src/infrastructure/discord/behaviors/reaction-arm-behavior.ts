import type { Logger } from "pino";

import { BehaviorEvent, BehaviorResult, type BotBehavior, type ReactionAddedContext } from "../../../application/behaviors/behavior.js";
import type { MessageReactionWatchStore } from "../../../application/chat/message-reaction-watch.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { CHAT_LIMITS } from "../../../config/guild-configuration-limits.js";

// Fixed window from the FIRST reaction, not a resetting debounce — a
// message that keeps accumulating reactions would otherwise never reach
// dueAt under a resetting timer, and reaction volume is exactly the signal
// this feature cares about. Its length is a random time within the guild's
// chat.reactionReplyWait{Min,Max}Minutes, picked when the window arms, so
// the bot's timing doesn't feel mechanical. See ReactionReplyScheduler for
// what happens once a row comes due.
export function reactionReplyWindowMs(
  profiles: Pick<GuildConfigurationProvider, "find">, guildId: string | null, random: () => number = Math.random,
): number {
  const chat = guildId ? profiles.find(guildId)?.chat : undefined;
  const a = chat?.reactionReplyWaitMinMinutes ?? CHAT_LIMITS.reactionReplyWaitMinMinutes.default;
  const b = chat?.reactionReplyWaitMaxMinutes ?? CHAT_LIMITS.reactionReplyWaitMaxMinutes.default;
  // The settings UI refuses min > max; a hand-edited config file might not.
  const minMs = Math.min(a, b) * 60_000;
  const maxMs = Math.max(a, b) * 60_000;
  return Math.round(minMs + random() * (maxMs - minMs));
}

// Arms a watched message's evaluation window on its first reaction —
// nothing more. The actual threshold check, LLM judgment, and delivery all
// happen later, off this event entirely, in ReactionReplyScheduler's own
// tick; this behavior's only job is turning "watching" into "pending" the
// moment it's warranted, as close to real time as a reaction actually
// happening, rather than waiting for the next poll.
export class ReactionArmBehavior implements BotBehavior<BehaviorEvent.ReactionAdded> {
  public readonly id = "reaction-arm";
  public readonly event = BehaviorEvent.ReactionAdded;
  public readonly priority = 100;

  public constructor(
    private readonly clientUserId: () => string | null,
    private readonly watchStore: MessageReactionWatchStore,
    private readonly profiles: Pick<GuildConfigurationProvider, "find">,
    private readonly logger: Logger,
  ) {}

  public matches(context: ReactionAddedContext): Promise<boolean> {
    // Ignore reactions from bots (including the bot's own, e.g. any
    // self-reaction it adds elsewhere) — only a real member's reaction
    // should ever arm or count toward the threshold.
    return Promise.resolve(!context.user.bot && context.user.id !== this.clientUserId());
  }

  public async execute(context: ReactionAddedContext): Promise<BehaviorResult> {
    const messageId = context.reaction.message.id;
    const guildId = context.reaction.message.guildId ?? null;
    try {
      const now = Date.now();
      const windowMs = reactionReplyWindowMs(this.profiles, guildId);
      const armed = await this.watchStore.armOnFirstReaction(messageId, now, windowMs);
      // Only the arming reaction is worth an info line; every other reaction
      // (unwatched message, already armed/closed) is routine.
      if (armed) {
        this.logger.info(
          { guildId, messageId, dueAt: new Date(now + windowMs).toISOString() },
          "Reaction-reply window armed",
        );
      } else {
        this.logger.debug({ messageId }, "Reaction ignored: message is not a watching reaction-reply target");
      }
    } catch (error) {
      this.logger.warn({ error, messageId }, "Failed to arm a message-reaction watch");
    }
    // Never stops propagation — other behaviors (none exist yet for
    // ReactionAdded, but the pattern matches every other event here) should
    // still see the same reaction.
    return BehaviorResult.Continue;
  }
}
