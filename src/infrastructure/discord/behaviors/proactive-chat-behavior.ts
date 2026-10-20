import type { Message } from "discord.js";
import type { Logger } from "pino";
import { BehaviorEvent, BehaviorResult, type BotBehavior } from "../../../application/behaviors/behavior.js";
import type { ChatConversationService } from "../../../application/chat/chat-conversation-service.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../../../config/guild-configuration.js";
import { resolveParticipation } from "../../../application/chat/participation-policy.js";
import { characterSettings } from "../../../application/chat/character-settings.js";
import { addressesBotName } from "../../../domain/chat/name-mention.js";
import type { SocialChatEligibility } from "./social-chat-eligibility.js";
import type { AmbientChatBehavior } from "./ambient-chat-behavior.js";
import { emitChatDiagnostic } from "../../../application/diagnostics/chat-diagnostics.js";
import { contextualFlow } from "../../../application/chat/contextual-flow.js";
import { ContextualCandidateBuffer } from "./contextual-candidate-buffer.js";

type OptionalTrigger = "continuation" | "spontaneous";
interface MessageBatch { messages: Message[]; seen: Set<string>; fingerprint: string; version: number; trigger: OptionalTrigger; participantId: string | null; timer?: ReturnType<typeof setTimeout>; firstAt: number }
const pauseMs = 5_000;
const singleMessagePauseMs = 12_000;
const maxWaitMs = 15_000;
export class ProactiveChatBehavior implements BotBehavior<BehaviorEvent.MessageCreated> {
  private readonly bursts = new Map<string, MessageBatch>();
  private readonly candidates: ContextualCandidateBuffer;
  public readonly id = "proactive-chat";
  public readonly event = BehaviorEvent.MessageCreated;
  public readonly priority = 80;
  public constructor(private readonly botId: () => string | null,
    private readonly profiles: GuildConfigurationProvider, private readonly conversation: ChatConversationService,
    private readonly eligibility: SocialChatEligibility, private readonly ambient: AmbientChatBehavior, private readonly logger: Logger) {
    this.candidates = new ContextualCandidateBuffer(logger, {
      fingerprint: (message): string | null => { const profile = message.guildId ? profiles.find(message.guildId) : null; return profile && contextualFlow(profile, message.channelId)
        ? this.fingerprint(profile, message.channelId) + conversation.optionalOpportunityVersion(message.guildId!, message.channelId) : null; },
      delay: (message): number => conversation.optionalEvaluationDelayMs(message.guildId!, message.channelId, resolveParticipation(profiles.find(message.guildId!)?.chat.participation, message.channelId).limits),
      threshold: (message): number => resolveParticipation(profiles.find(message.guildId!)?.chat.participation, message.channelId).messagesPerDecision,
      eligible: async (message): Promise<boolean> => { const trigger = this.trigger(message); return trigger !== null && (await eligibility.check(message, trigger)).eligible; },
      schedule: (message, work): void => conversation.bufferOpportunity(message.guildId!, message.channelId, work),
      evaluate: async (message, burst): Promise<void> => { const trigger = this.trigger(message); if (trigger) await ambient.execute(message, trigger, burst); },
    });
  }

  private report(batch: MessageBatch, reason: "batch_threshold" | "pause_or_cooldown" | "continuation_candidate" | "submitted" | "invalidated", delayMs = 0): void {
    emitChatDiagnostic(this.logger, { event: "chat.admission.buffered", triggerMode: batch.trigger, reason, messages: batch.messages.length, delayMs });
  }
  private fingerprint(profile: GuildConfiguration, channelId: string): string {
    return JSON.stringify([profile.chat.participation, profile.features.chatbot, profile.features.channelHistory, profile.character,
      profile.chat.channelMemoryModes[channelId], [...profile.channels.chatbot], [...profile.roles.chatbot], [...profile.roles.botAdministrator], [...profile.roles.restricted]]);
  }
  private pending(message: Message, profile: GuildConfiguration): MessageBatch | undefined {
    const key = `${message.guildId}:${message.channelId}`; const batch = this.bursts.get(key);
    if (batch && (batch.fingerprint !== this.fingerprint(profile, message.channelId) ||
        batch.version !== this.conversation.optionalOpportunityVersion(message.guildId!, message.channelId))) {
      if (batch.timer) clearTimeout(batch.timer);
      this.bursts.delete(key); return undefined;
    }
    return batch;
  }
  private trigger(message: Message): OptionalTrigger | null {
    const botId = this.botId();
    const profile = message.guildId ? this.profiles.find(message.guildId) : null;
    if (!botId || !profile || (!this.conversation.optionalDecisionAvailable && profile.chat.participation?.continuationFailureMode !== "grounded_fallback") || !profile.features.chatbot || !profile.features.channelHistory || characterSettings(profile).channelOverrides[message.channelId]?.contextEnabled === false ||
        profile.chat.channelMemoryModes[message.channelId] === "disabled" || !message.inGuild() || message.author.bot || message.mentions.users.has(botId)) return null;
    if (addressesBotName(message.content, profile.displayName) || message.mentions.repliedUser?.id === botId ||
        message.reference?.messageId && message.channel?.messages?.cache?.get(message.reference.messageId)?.author.id === botId) return null;
    const policy = resolveParticipation(profile.chat.participation, message.channelId);
    if (contextualFlow(profile, message.channelId) && this.conversation.optionalDecisionAvailable && (!!message.content.trim() || (message.attachments?.size ?? 0) > 0))
      return policy.spontaneousEnabled ? "spontaneous" : policy.continuationEnabled ? "continuation" : null;
    if (policy.continuationEnabled && this.conversation.isImplicitlyAddressed(message.guildId, message.channelId, { messageId: message.id, timestampMs: message.createdTimestamp,
        authorId: message.author.id, authorDisplayName: message.author.displayName, content: message.content, imageCount: 0,
        replyToMessageId: message.reference?.messageId ?? null }, botId)) return "continuation";
    const hasContent = !!message.content.trim() || (message.attachments?.size ?? 0) > 0;
    return this.conversation.optionalDecisionAvailable && policy.spontaneousEnabled && hasContent ? "spontaneous" : null;
  }
  public async matches(message: Message): Promise<boolean> {
    const trigger = this.trigger(message);
    const eligible = trigger !== null && (await this.eligibility.check(message, trigger)).eligible;
    if (!eligible && trigger === null && message.guildId && !message.author.bot) {
      this.candidates.cancel(message);
      const key = `${message.guildId}:${message.channelId}`;
      const batch = this.bursts.get(key); if (batch?.timer) clearTimeout(batch.timer);
      this.bursts.delete(key);
    }
    return eligible;
  }
  public async execute(message: Message): Promise<BehaviorResult> {
    const trigger = this.trigger(message);
    if (!trigger || !(await this.eligibility.check(message, trigger)).eligible) return BehaviorResult.Continue;
    const profile = this.profiles.find(message.guildId!); if (!profile) return BehaviorResult.Continue;
    if (contextualFlow(profile, message.channelId)) { this.candidates.add(message); return BehaviorResult.Continue; }
    const key = `${message.guildId}:${message.channelId}`;
    if (this.bursts.size >= 256 && !this.bursts.has(key)) {
      const oldest = this.bursts.keys().next().value!; const abandoned = this.bursts.get(oldest);
      if (abandoned?.timer) clearTimeout(abandoned.timer);
      this.bursts.delete(oldest);
    }
    const pending = this.pending(message, profile);
    const participantId = trigger === "continuation" ? message.author.id : null;
    if (pending && (pending.trigger !== trigger || pending.participantId !== participantId) && pending.timer) clearTimeout(pending.timer);
    const batch = pending?.trigger === trigger && pending.participantId === participantId ? pending : { messages: [], seen: new Set<string>(), fingerprint: this.fingerprint(profile, message.channelId),
      version: this.conversation.optionalOpportunityVersion(message.guildId!, message.channelId), trigger, participantId, firstAt: Date.now() };
    if (batch.seen.has(message.id)) return BehaviorResult.Continue;
    batch.seen.add(message.id); while (batch.seen.size > 64) batch.seen.delete(batch.seen.values().next().value!);
    batch.messages = [...batch.messages, message].slice(-20);
    this.bursts.set(key, batch);
    if (trigger === "spontaneous") {
      const maximum = resolveParticipation(profile.chat.participation, message.channelId).messagesPerDecision;
      const turns = batch.messages.reduce((count, item, index, items) => count + (index === 0 || item.author.id !== items[index - 1]!.author.id ? 1 : 0), 0);
      const substantive = batch.messages.some((item) => item.content.trim().length >= 40);
      if (batch.timer) clearTimeout(batch.timer);
      if (turns < Math.min(3, maximum) && batch.messages.length < maximum && !substantive) {
        this.report(batch, "batch_threshold"); return BehaviorResult.Continue;
      }
      const pause = turns >= maximum || batch.messages.length >= maximum ? 0 : Math.min(turns >= 3 ? pauseMs : singleMessagePauseMs, Math.max(0, batch.firstAt + maxWaitMs - Date.now()));
      const delay = Math.max(pause, this.conversation.optionalEvaluationDelayMs?.(message.guildId!, message.channelId, resolveParticipation(profile.chat.participation, message.channelId).limits) ?? 0);
      this.report(batch, "pause_or_cooldown", delay);
      batch.timer = setTimeout(() => this.schedule(message, batch), delay);
      batch.timer.unref?.();
    } else {
      const delay = this.conversation.optionalEvaluationDelayMs?.(message.guildId!, message.channelId, resolveParticipation(profile.chat.participation, message.channelId).limits) ?? 0;
      this.report(batch, "continuation_candidate", delay);
      if (batch.timer) clearTimeout(batch.timer);
      if (delay > 0) {
        batch.timer = setTimeout(() => this.schedule(message, batch), delay); batch.timer.unref?.();
      } else this.schedule(message, batch);
    }
    return BehaviorResult.Continue;
  }
  private schedule(message: Message, batch: MessageBatch): void {
    this.conversation.bufferOpportunity(message.guildId!, message.channelId, () => {
      void this.flush(message, batch).catch((error: unknown) => this.logger.warn({ error, guildId: message.guildId, channelId: message.channelId }, "Optional participation failed"));
    });
  }
  private async flush(source: Message, batch: MessageBatch): Promise<void> {
    const profile = this.profiles.find(source.guildId!);
    if (!profile || this.pending(source, profile) !== batch) { this.report(batch, "invalidated"); return; }
    const snapshot = [...batch.messages];
    const burst = (await Promise.all(snapshot.map(async (message) => {
      const trigger = this.trigger(message);
      return trigger === batch.trigger && (await this.eligibility.check(message, trigger)).eligible ? message : null;
    }))).filter((message): message is Message => message !== null);
    const current = this.profiles.find(source.guildId!);
    if (!current || this.pending(source, current) !== batch || batch.messages.at(-1)?.id !== snapshot.at(-1)?.id) return;
    batch.messages = burst;
    if (!burst.length) { this.report(batch, "invalidated"); return; }
    this.report(batch, "submitted");
    const latest = burst.at(-1)!; const trigger = this.trigger(latest); batch.messages = [];
    batch.firstAt = Date.now();
    if (trigger) await this.ambient.execute(latest, trigger, burst);
  }
}
