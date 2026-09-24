import type { Client, GuildTextBasedChannel, Message } from "discord.js";
import type { Logger } from "pino";

import { ChatAccessService } from "../../../application/access/chat-access-service.js";
import { chatMemoryLimits } from "../../../application/chat/chat-memory-policy.js";
import type { ChannelHistoryMessage } from "../../../application/chat/chat-provider.js";
import { ChatStateCommitError, type ChatConversationService } from "../../../application/chat/chat-conversation-service.js";
import type { MessageReactionWatch, MessageReactionWatchStore } from "../../../application/chat/message-reaction-watch.js";
import type { PersonaSource } from "../../../application/chat/persona-source.js";
import type { ApplicationConfiguration } from "../../../config/configuration.js";
import type { GuildConfiguration } from "../../../config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { KeyedSerialQueue } from "../../../application/concurrency/keyed-serial-queue.js";
import { ChatTurnSupport } from "./chat-turn-support.js";

// Polled far more often than ChannelSummaryScheduler's hourly cadence —
// the reaction-reply wait (chat.reactionReplyWaitMinMinutes, at least 1 minute,
// see reaction-arm-behavior.ts) needs a tick granularity no coarser than
// that, or "due" rows would routinely wait much longer than promised.
const checkIntervalMs = 60 * 1_000;
// Bounds one tick's own runtime the same way ChannelSummaryScheduler's
// maxJobsProcessedPerTick does — a backlog after downtime simply spreads
// across more ticks rather than blocking the loop.
const maxWatchesProcessedPerTick = 50;
// Below this many distinct eligible human reactors, a watch is marked done
// WITHOUT calling the model. One is enough — the real gate is the model's
// own reply/react/ignore judgment; the chat.reactionReplyWait*Minutes wait
// (see reaction-arm-behavior.ts) is what lets others pile on before evaluation.
// Counts unique reactors across every emoji on the message, not raw
// reaction-add events.
const reactionReplyThreshold = 1;
// Backstop retention — see PersonalMemoryExtractionQueueStore.deleteTerminalOlderThan
// for the same rationale: a "watching" row nobody ever reacted to, or a
// "done" row nothing will re-query, both eventually just age out.
const watchRetentionMs = 7 * 24 * 60 * 60 * 1_000;

// Evaluates reaction-armed chat replies once their window comes due: counts
// unique reactors, and — only above threshold — asks the model whether the
// reaction volume is actually worth commenting on (the same
// reply/ignore/react judgment AmbientChatBehavior already uses, via the
// same ChatConversationService.run call), with the original message's
// author standing in as the turn's `currentUser` since a reaction has no
// single author of its own the way a message does. Every due row is marked
// "done" exactly once no matter the outcome — see MessageReactionWatch's
// own doc comment for why this never re-arms.
// A message-fetch/channel-fetch/reactor-fetch/model failure gets this many
// total attempts (spread across scheduler ticks, ~1/minute) before the watch
// is given up on — bounds retries without a persisted attempt counter/
// migration: a genuine deletion (Unknown Message/Channel) is detected and
// given up on immediately instead, since retrying that can never succeed.
const maxAttempts = 3;

// Evaluates reaction-armed chat replies once their window comes due: counts
// unique reactors, and — only above threshold — asks the model whether the
// reaction volume is actually worth commenting on (the same
// reply/ignore/react judgment AmbientChatBehavior already uses, via the
// same ChatConversationService.run call), with the original message's
// author standing in as the turn's `currentUser` since a reaction has no
// single author of its own the way a message does. Every due row is marked
// "done" exactly once no matter the outcome — see MessageReactionWatch's
// own doc comment for why this never re-arms.
export class ReactionReplyScheduler {
  private checkTimer: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private currentTick: Promise<void> | null = null;
  private readonly perMessageQueue = new KeyedSerialQueue();
  private readonly turnSupport: ChatTurnSupport;
  private readonly chatAccess: ChatAccessService;
  // In-memory only — a process restart resets a watch's attempt count back
  // to zero, which just means a couple of extra retries in the worst case,
  // never fewer than intended. Not worth a schema migration/persisted
  // column for a bound this small.
  private readonly attemptsByMessageId = new Map<string, number>();

  public constructor(
    private readonly client: Client,
    private readonly watchStore: MessageReactionWatchStore,
    private readonly profiles: GuildConfigurationProvider,
    private readonly conversation: ChatConversationService,
    private readonly personaSource: PersonaSource,
    private readonly logger: Logger,
    configuration: ApplicationConfiguration,
  ) {
    this.turnSupport = new ChatTurnSupport(logger);
    this.chatAccess = new ChatAccessService(configuration);
  }

  // true: still has attempts left, caller should leave the watch pending
  // for the next tick to retry (the row is already "due", so dequeueDue
  // will just pick it up again — no separate re-arm needed). false: out of
  // attempts, caller should give up (markDone).
  private shouldRetry(messageId: string): boolean {
    const attempts = (this.attemptsByMessageId.get(messageId) ?? 0) + 1;
    if (attempts >= maxAttempts) {
      this.attemptsByMessageId.delete(messageId);
      return false;
    }
    this.attemptsByMessageId.set(messageId, attempts);
    return true;
  }

  // Every terminal outcome goes through here with a reason, so a single
  // "Reaction-reply watch closed" line per watched message says exactly
  // which gate stopped it (or that it replied).
  private async giveUp(
    watch: Pick<MessageReactionWatch, "messageId" | "guildId">, now: number, reason: string, fields: Record<string, unknown> = {},
  ): Promise<void> {
    this.attemptsByMessageId.delete(watch.messageId);
    await this.watchStore.markDone(watch.messageId, now);
    this.logger.info({ guildId: watch.guildId, messageId: watch.messageId, reason, ...fields }, "Reaction-reply watch closed");
  }

  public start(): void {
    void this.checkNow(Date.now());
    if (this.checkTimer) return;
    this.checkTimer = setInterval(() => void this.checkNow(Date.now()), checkIntervalMs);
    this.checkTimer.unref();
  }

  public stop(): void {
    if (!this.checkTimer) return;
    clearInterval(this.checkTimer);
    this.checkTimer = null;
  }

  public checkNow(now: number): Promise<void> {
    if (this.tickInFlight) {
      this.logger.warn("Reaction-reply tick skipped — previous tick still running.");
      return Promise.resolve();
    }
    this.tickInFlight = true;
    const tick = (async (): Promise<void> => {
      try {
        const due = await this.watchStore.dequeueDue(maxWatchesProcessedPerTick, now);
        for (const watch of due) {
          await this.perMessageQueue.run(watch.messageId, async () => {
            try {
              await this.evaluate(watch, now);
            } catch (error) {
              // Genuinely unexpected (evaluate() handles its own known
              // failure modes internally) — still bounded-retry rather than
              // an unconditional markDone, so a transient bug/outage here
              // doesn't burn the watch on its very first tick either.
              if (this.shouldRetry(watch.messageId)) {
                this.logger.warn({ error, messageId: watch.messageId, guildId: watch.guildId }, "Reaction-reply evaluation failed unexpectedly, will retry");
                return;
              }
              this.logger.error({ error, messageId: watch.messageId, guildId: watch.guildId }, "Reaction-reply evaluation failed repeatedly, giving up");
              await this.giveUp(watch, now, "evaluation_failed").catch(() => undefined);
            }
          });
        }
        await this.watchStore.deleteOlderThan(now - watchRetentionMs).catch((error: unknown) => {
          this.logger.error({ error }, "Message-reaction watch retention cleanup failed");
        });
      } finally {
        this.tickInFlight = false;
      }
    })();
    this.currentTick = tick;
    return tick;
  }

  // Same shutdown-race rationale as ChannelSummaryScheduler.drain.
  public async drain(timeoutMs = 40_000): Promise<void> {
    if (!this.currentTick) return;
    const tick = this.currentTick;
    const timedOut = new Promise<"timed_out">((resolve) => {
      setTimeout(() => resolve("timed_out"), timeoutMs).unref?.();
    });
    const result = await Promise.race([tick.then(() => "completed" as const), timedOut]);
    if (result === "timed_out") {
      this.logger.warn({ timeoutMs }, "Shutdown drain timed out with a reaction-reply tick still in flight");
    }
  }

  private async evaluate(watch: MessageReactionWatch, now: number): Promise<void> {
    const profile = this.profiles.find(watch.guildId);
    // Feature may have been turned off after this row was registered —
    // honor the current setting, not the one at registration time. Not
    // retryable — this is a real, current decision, not a fetch failure.
    if (!profile?.features.chatbot || !profile.features.reactionReplies) {
      await this.giveUp(watch, now, "feature_disabled");
      return;
    }
    let channel: Awaited<ReturnType<Client["channels"]["fetch"]>>;
    try {
      channel = await this.client.channels.fetch(watch.channelId);
    } catch (error) {
      await this.handleFetchFailure(watch, now, error, "Failed to fetch the watched channel");
      return;
    }
    if (!channel || !channel.isTextBased() || channel.isDMBased() || channel.guildId !== watch.guildId) {
      // Not a fetch failure — genuinely the wrong/unusable channel now.
      await this.giveUp(watch, now, "channel_unusable");
      return;
    }
    let message: Message | null;
    try {
      message = await channel.messages.fetch(watch.messageId);
    } catch (error) {
      await this.handleFetchFailure(watch, now, error, "Failed to fetch the watched message");
      return;
    }
    if (!message || message.author.id !== this.client.user?.id) {
      // Deleted (resolved null instead of throwing), or — shouldn't happen
      // — somehow not our message anymore. Not retryable either way.
      await this.giveUp(watch, now, "message_gone");
      return;
    }

    const { reactorIds, complete } = await this.collectUniqueReactorIds(message, profile, watch.channelId);
    if (!complete) {
      await this.handleFetchFailure(watch, now, null, "Failed to fully fetch this message's reactor lists");
      return;
    }
    if (reactorIds.size < reactionReplyThreshold) {
      // A real, current count below threshold — not a failure, so this
      // never retries even though it superficially looks similar to one.
      await this.giveUp(watch, now, "below_threshold", { reactorCount: reactorIds.size, threshold: reactionReplyThreshold });
      return;
    }

    try {
      const outcome = await this.replyToReactions(message, channel, profile.guildId, reactorIds);
      await this.giveUp(watch, now, outcome, { reactorCount: reactorIds.size });
    } catch (error) {
      if (this.shouldRetry(watch.messageId)) {
        this.logger.warn({ error, messageId: watch.messageId, guildId: watch.guildId }, "Reaction-reply turn failed, will retry");
        return;
      }
      this.logger.error({ error, messageId: watch.messageId, guildId: watch.guildId }, "Reaction-reply turn failed repeatedly, giving up");
      await this.giveUp(watch, now, "turn_failed");
    }
  }

  // A DiscordAPIError for "Unknown Message"/"Unknown Channel"/"Missing
  // Access" means the target is genuinely gone or unreachable — retrying
  // can never succeed, so that's treated as terminal. Anything else
  // (network blip, rate limit, a 5xx) is presumed transient and gets a
  // bounded retry instead of permanently burning the watch on one hiccup.
  private async handleFetchFailure(watch: MessageReactionWatch, now: number, error: unknown, message: string): Promise<void> {
    const messageId = watch.messageId;
    const code = (error as { code?: number } | null)?.code;
    const terminal = code === 10008 || code === 10003 || code === 50001 || code === 50013;
    if (terminal) {
      await this.giveUp(watch, now, "unreachable", { code });
      return;
    }
    if (this.shouldRetry(messageId)) {
      this.logger.warn({ error, messageId }, `${message}, will retry`);
      return;
    }
    this.logger.error({ error, messageId }, `${message} repeatedly, giving up`);
    await this.giveUp(watch, now, "fetch_failed");
  }

  // Excludes the bot's own id (it never counts toward its own threshold),
  // any other bot, and anyone the guild's normal chat-access policy
  // (role/channel allow-list) wouldn't let talk to the bot at all — a
  // restricted member's emoji shouldn't be able to trigger or shape a
  // reply any more than their words could. Fetches each emoji's reactor
  // list rather than trusting `.count`/cache alone — a reaction on a
  // message the bot wasn't actively watching when it landed is routinely
  // not fully cached. `complete: false` means at least one emoji's reactor
  // list couldn't be fetched — the caller treats that as a transient
  // failure (retry) rather than evaluating a possibly-undercounted total.
  private async collectUniqueReactorIds(
    message: Message, profile: GuildConfiguration, channelId: string,
  ): Promise<{ reactorIds: Set<string>; complete: boolean }> {
    const rawIds = new Set<string>();
    let complete = true;
    for (const reaction of message.reactions.cache.values()) {
      const users = await reaction.users.fetch().catch(() => null);
      if (!users) {
        complete = false;
        continue;
      }
      for (const user of users.values()) {
        if (user.bot) continue;
        rawIds.add(user.id);
      }
    }
    const eligibleIds = new Set<string>();
    for (const id of rawIds) {
      const member = await message.guild?.members.fetch(id).catch(() => null) ?? null;
      if (this.chatAccess.canUseMentionChat(profile, member, id, channelId)) eligibleIds.add(id);
    }
    return { reactorIds: eligibleIds, complete };
  }

  private async replyToReactions(
    message: Message, channel: GuildTextBasedChannel, guildId: string, reactorIds: ReadonlySet<string>,
  ): Promise<string> {
    const profile = this.profiles.find(guildId);
    if (!profile) return "feature_disabled";
    const author = message.author;
    const reactorList = [...reactorIds].filter((id) => id !== author.id);
    const mentionedUsers = await Promise.all(reactorList.slice(0, 20).map(async (id) => {
      const member = await message.guild?.members.fetch(id).catch(() => null);
      return { id, displayName: member?.displayName ?? id, roleNames: [] as string[] };
    }));
    // `before: null` — fetch the most recent channel activity rather than
    // "before message.id", since this turn is evaluated minutes after
    // `message` was sent and needs to see whatever was said in between
    // (see ChatTurnSupport.resolveChannelHistory's own doc comment).
    const channelHistory: ChannelHistoryMessage[] = profile.features.channelHistory
      ? this.turnSupport.toChannelHistoryMessages(await this.turnSupport.resolveChannelHistory(
          message, profile.chat.channelHistoryLimit, new Set([message.id]), null,
        ))
      : [];
    const currentUser = {
      id: author.id,
      displayName: message.member?.displayName ?? author.username,
      roleNames: message.member?.roles.cache
        .filter((role) => role.id !== guildId)
        .map((role) => role.name.slice(0, 50))
        .slice(0, 10) ?? [],
    };
    const syntheticPrompt = `(${reactorIds.size} ${reactorIds.size === 1 ? "person" : "people"} reacted to your message: ` +
      `${message.content.slice(0, chatMemoryLimits.maxUserMessageChars)})`;
    const persona = await this.personaSource.resolve(profile);

    try {
      const response = await this.conversation.run({
        guildId, channelId: message.channelId, sourceMessageId: message.id,
        personality: persona.personality, examplePool: persona.examplePool, loreChunks: persona.loreChunks,
        personaDrift: persona.personaDrift, personaDriftEnabled: profile.chat.personaDriftEnabled,
        personalitySourceHash: persona.personalitySourceHash,
        currentUser, mentionedUsers,
        message: syntheticPrompt,
        replyChain: [], replyChainOverflow: [], channelHistory,
        images: [], webSearchMode: profile.chat.webSearchMode,
        imageGenerationEnabled: false, includeSources: profile.chat.includeSources,
        triggerMode: "reaction",
        historyReactionsEnabled: profile.features.historyReactions && profile.features.channelHistory,
        toolsEnabled: false,
        channelMemoryModes: profile.chat.channelMemoryModes,
        channelIsNsfw: "nsfw" in channel ? Boolean(channel.nsfw) : false,
      }, async (deliveredResponse) => {
        const { deliveredText } = await this.turnSupport.deliverChatResponse({
          sender: {
            first: (payload) => message.reply({
              content: payload.content, files: [...payload.files],
              allowedMentions: { repliedUser: false, parse: [] },
            }),
            rest: (payload) => channel.send({
              content: payload.content, files: [...payload.files],
              allowedMentions: { repliedUser: false, parse: [] },
            }),
          },
          text: deliveredResponse.text,
          sources: deliveredResponse.sources,
          images: deliveredResponse.generatedImages,
          emptyFallbackContent: "I ran out of words. Very premium of me.",
          maxImageAggregateBytes: 8 * 1024 * 1024,
        });
        return deliveredText;
      });
      if (response.reactionEmoji) {
        await message.react(response.reactionEmoji).catch((error: unknown) => {
          this.logger.warn({ error, messageId: message.id }, "Reaction-reply: failed to react with the model-chosen emoji");
        });
      }
      if (response.historyReactions.length > 0) {
        await this.turnSupport.applyHistoryReactions(
          channel, response.historyReactions, { guildId, channelId: message.channelId, sourceMessageId: message.id },
        );
      }
      return response.ambientAction === "reply" ? "replied" : response.reactionEmoji ? "reacted_only" : "model_ignored";
    } catch (error) {
      if (error instanceof ChatStateCommitError) {
        // The reply was already delivered before the commit failed —
        // terminal, not retryable: retrying would post a second reply for
        // the same reaction burst. Swallowed here (not rethrown) so
        // evaluate()'s catch doesn't apply its bounded retry to this case.
        this.logger.warn({ error, messageId: message.id, guildId }, "Reaction-reply exchange could not be saved");
        return "replied_unsaved";
      }
      // Anything else (model/provider failure, a delivery error before
      // anything was sent) is presumed transient — rethrown so evaluate()
      // applies its bounded retry instead of burning the watch here.
      throw error;
    }
  }
}
