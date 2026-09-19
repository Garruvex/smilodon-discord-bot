import type { Client, GuildTextBasedChannel, Message } from "discord.js";
import type { Logger } from "pino";

import { chatMemoryLimits } from "../../../application/chat/chat-memory-policy.js";
import type { ChannelHistoryMessage } from "../../../application/chat/chat-provider.js";
import { ChatStateCommitError, type ChatConversationService } from "../../../application/chat/chat-conversation-service.js";
import type { MessageReactionWatch, MessageReactionWatchStore } from "../../../application/chat/message-reaction-watch.js";
import type { PersonaSource } from "../../../application/chat/persona-source.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { KeyedSerialQueue } from "../../../application/concurrency/keyed-serial-queue.js";
import { ChatTurnSupport } from "./chat-turn-support.js";

// Polled far more often than ChannelSummaryScheduler's hourly cadence —
// reactionReplyWindowMs (5 minutes, see reaction-arm-behavior.ts) needs a
// tick granularity well under that or "due" rows would routinely wait much
// longer than the window actually promises.
const checkIntervalMs = 60 * 1_000;
// Bounds one tick's own runtime the same way ChannelSummaryScheduler's
// maxJobsProcessedPerTick does — a backlog after downtime simply spreads
// across more ticks rather than blocking the loop.
const maxWatchesProcessedPerTick = 50;
// Below this many distinct human reactors, a watch is evaluated and marked
// done WITHOUT ever calling the model — most messages get a handful of
// ordinary reactions and should cost nothing. Counts unique reactors across
// every emoji on the message, not raw reaction-add events, so one person
// reacting with several different emoji can't cross this alone.
const reactionReplyThreshold = 5;
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
export class ReactionReplyScheduler {
  private checkTimer: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private currentTick: Promise<void> | null = null;
  private readonly perMessageQueue = new KeyedSerialQueue();
  private readonly turnSupport: ChatTurnSupport;

  public constructor(
    private readonly client: Client,
    private readonly watchStore: MessageReactionWatchStore,
    private readonly profiles: GuildConfigurationProvider,
    private readonly conversation: ChatConversationService,
    private readonly personaSource: PersonaSource,
    private readonly logger: Logger,
  ) {
    this.turnSupport = new ChatTurnSupport(logger);
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
              this.logger.error({ error, messageId: watch.messageId, guildId: watch.guildId }, "Reaction-reply evaluation failed unexpectedly");
              await this.watchStore.markDone(watch.messageId, now).catch(() => undefined);
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
    // honor the current setting, not the one at registration time.
    if (!profile?.features.chatbot || !profile.features.reactionReplies) {
      await this.watchStore.markDone(watch.messageId, now);
      return;
    }
    const channel = await this.client.channels.fetch(watch.channelId).catch(() => null);
    if (!channel?.isTextBased() || channel.isDMBased() || channel.guildId !== watch.guildId) {
      await this.watchStore.markDone(watch.messageId, now);
      return;
    }
    const message = await channel.messages.fetch(watch.messageId).catch(() => null);
    if (!message || message.author.id !== this.client.user?.id) {
      // Deleted, or (shouldn't happen) somehow not our own message anymore.
      await this.watchStore.markDone(watch.messageId, now);
      return;
    }

    const reactorIds = await this.collectUniqueReactorIds(message);
    if (reactorIds.size < reactionReplyThreshold) {
      await this.watchStore.markDone(watch.messageId, now);
      return;
    }

    try {
      await this.replyToReactions(message, channel, profile.guildId, reactorIds);
    } finally {
      await this.watchStore.markDone(watch.messageId, now);
    }
  }

  // Excludes the bot's own id (it never counts toward its own threshold)
  // and any other bot. Fetches each emoji's reactor list rather than
  // trusting `.count`/cache alone — a reaction on a message the bot wasn't
  // actively watching when it landed is routinely not fully cached.
  private async collectUniqueReactorIds(message: Message): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const reaction of message.reactions.cache.values()) {
      const users = await reaction.users.fetch().catch(() => null);
      if (!users) continue;
      for (const user of users.values()) {
        if (user.bot) continue;
        ids.add(user.id);
      }
    }
    return ids;
  }

  private async replyToReactions(
    message: Message, channel: GuildTextBasedChannel, guildId: string, reactorIds: ReadonlySet<string>,
  ): Promise<void> {
    const profile = this.profiles.find(guildId);
    if (!profile) return;
    const author = message.author;
    const reactorList = [...reactorIds].filter((id) => id !== author.id);
    const mentionedUsers = await Promise.all(reactorList.slice(0, 20).map(async (id) => {
      const member = await message.guild?.members.fetch(id).catch(() => null);
      return { id, displayName: member?.displayName ?? id, roleNames: [] as string[] };
    }));
    const channelHistory: ChannelHistoryMessage[] = profile.features.channelHistory
      ? this.turnSupport.toChannelHistoryMessages(await this.turnSupport.resolveChannelHistory(
          message, profile.chat.channelHistoryLimit, new Set([message.id]),
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
    const syntheticPrompt = `(${reactorIds.size} people reacted to your message: ` +
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
        triggerMode: "ambient",
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
    } catch (error) {
      if (error instanceof ChatStateCommitError) {
        this.logger.warn({ error, messageId: message.id, guildId }, "Reaction-reply exchange could not be saved");
        return;
      }
      this.logger.error({ error, messageId: message.id, guildId }, "Reaction-reply request failed");
    }
  }
}
