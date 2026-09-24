import type { Logger } from "pino";

import { BehaviorEvent, BehaviorResult, type BotBehavior, type ReactionAddedContext } from "../../../application/behaviors/behavior.js";
import type { MessageReactionWatchStore } from "../../../application/chat/message-reaction-watch.js";

// Fixed window from the FIRST reaction, not a resetting debounce — a
// message that keeps accumulating reactions would otherwise never reach
// dueAt under a resetting timer, and reaction volume is exactly the signal
// this feature cares about. See ReactionReplyScheduler for what happens
// once a row comes due.
export const reactionReplyWindowMs = 5 * 60 * 1_000;

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
    try {
      const now = Date.now();
      const armed = await this.watchStore.armOnFirstReaction(messageId, now, reactionReplyWindowMs);
      // Only the arming reaction is worth an info line; every other reaction
      // (unwatched message, already armed/closed) is routine.
      if (armed) {
        this.logger.info(
          { guildId: context.reaction.message.guildId, messageId, dueAt: new Date(now + reactionReplyWindowMs).toISOString() },
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
