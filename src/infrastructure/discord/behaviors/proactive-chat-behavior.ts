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

interface MessageBatch { messages: Message[]; seen: Map<string, number>; fingerprint: string; version: number; touchedAt: number }
const batchIdleMs = 120_000;
export class ProactiveChatBehavior implements BotBehavior<BehaviorEvent.MessageCreated> {
  private readonly bursts = new Map<string, MessageBatch>();
  public readonly id = "proactive-chat";
  public readonly event = BehaviorEvent.MessageCreated;
  public readonly priority = 80;
  public constructor(private readonly botId: () => string | null,
    private readonly profiles: GuildConfigurationProvider, private readonly conversation: ChatConversationService,
    private readonly eligibility: SocialChatEligibility, private readonly ambient: AmbientChatBehavior, private readonly logger: Logger) {}

  private fingerprint(profile: GuildConfiguration, channelId: string): string {
    return JSON.stringify([profile.chat.participation, profile.features.chatbot, profile.features.channelHistory, profile.character,
      profile.chat.channelMemoryModes[channelId], [...profile.channels.chatbot], [...profile.roles.chatbot], [...profile.roles.botAdministrator], [...profile.roles.restricted]]);
  }
  private pending(message: Message, profile: GuildConfiguration): MessageBatch | undefined {
    const key = `${message.guildId}:${message.channelId}`; const batch = this.bursts.get(key);
    if (batch && (batch.fingerprint !== this.fingerprint(profile, message.channelId) || Date.now() - batch.touchedAt >= batchIdleMs ||
        batch.version !== this.conversation.optionalOpportunityVersion(message.guildId!, message.channelId))) {
      this.bursts.delete(key); return undefined;
    }
    return batch;
  }
  private trigger(message: Message): "continuation" | "spontaneous" | null {
    const botId = this.botId();
    const profile = message.guildId ? this.profiles.find(message.guildId) : null;
    if (!this.conversation.optionalDecisionAvailable || !botId || !profile || !profile.features.chatbot || !profile.features.channelHistory || characterSettings(profile).channelOverrides[message.channelId]?.contextEnabled === false ||
        profile.chat.channelMemoryModes[message.channelId] === "disabled" || !message.inGuild() || message.author.bot || message.mentions.users.has(botId)) return null;
    if (addressesBotName(message.content, profile.displayName) || message.mentions.repliedUser?.id === botId ||
        message.reference?.messageId && message.channel?.messages?.cache?.get(message.reference.messageId)?.author.id === botId) return null;
    const policy = resolveParticipation(profile.chat.participation, message.channelId);
    const batch = this.pending(message, profile);
    if (policy.continuationEnabled && this.conversation.isImplicitlyAddressed(message.guildId, message.channelId, { messageId: message.id, timestampMs: message.createdTimestamp,
        authorId: message.author.id, authorDisplayName: message.author.displayName, content: message.content, imageCount: 0,
        replyToMessageId: message.reference?.messageId ?? null }, botId)) return "continuation";
    const hasContent = !!message.content.trim() || (message.attachments?.size ?? 0) > 0;
    return policy.spontaneousEnabled && hasContent && (policy.messagesPerDecision > 1 || message.content.trim().length >= 12 || (batch?.messages.length ?? 0) > 0) ? "spontaneous" : null;
  }
  public async matches(message: Message): Promise<boolean> {
    const trigger = this.trigger(message);
    const eligible = trigger !== null && (await this.eligibility.check(message, trigger)).eligible;
    if (!eligible && trigger === null && message.guildId && !message.author.bot) this.bursts.delete(`${message.guildId}:${message.channelId}`);
    return eligible;
  }
  public async execute(message: Message): Promise<BehaviorResult> {
    const trigger = this.trigger(message);
    if (!trigger || !(await this.eligibility.check(message, trigger)).eligible) return BehaviorResult.Continue;
    const profile = this.profiles.find(message.guildId!); if (!profile) return BehaviorResult.Continue;
    const key = `${message.guildId}:${message.channelId}`;
    if (this.bursts.size >= 256 && !this.bursts.has(key)) this.bursts.delete(this.bursts.keys().next().value!);
    const now = Date.now();
    const batch = this.pending(message, profile) ?? { messages: [], seen: new Map<string, number>(), fingerprint: this.fingerprint(profile, message.channelId),
      version: this.conversation.optionalOpportunityVersion(message.guildId!, message.channelId), touchedAt: now };
    for (const [id, at] of batch.seen) if (now - at >= batchIdleMs) batch.seen.delete(id);
    if (batch.seen.has(message.id)) return BehaviorResult.Continue;
    batch.seen.set(message.id, now); while (batch.seen.size > 64) batch.seen.delete(batch.seen.keys().next().value!);
    batch.messages = [...batch.messages.filter((item) => now - item.createdTimestamp < batchIdleMs), message].slice(-20);
    batch.touchedAt = now; this.bursts.set(key, batch);
    if (batch.messages.length < resolveParticipation(profile.chat.participation, message.channelId).messagesPerDecision) return BehaviorResult.Continue;
    this.conversation.bufferOpportunity(message.guildId!, message.channelId, () => {
      void this.flush(message, batch).catch((error: unknown) => this.logger.warn({ error, guildId: message.guildId, channelId: message.channelId }, "Optional participation failed"));
    });
    return BehaviorResult.Continue;
  }
  private async flush(source: Message, batch: MessageBatch): Promise<void> {
    const profile = this.profiles.find(source.guildId!);
    if (!profile || this.pending(source, profile) !== batch) return;
    const snapshot = batch.messages.filter((item) => Date.now() - item.createdTimestamp < batchIdleMs);
    const burst = (await Promise.all(snapshot.map(async (message) => {
      const trigger = this.trigger(message);
      return trigger && (await this.eligibility.check(message, trigger)).eligible ? message : null;
    }))).filter((message): message is Message => message !== null);
    const current = this.profiles.find(source.guildId!);
    if (!current || this.pending(source, current) !== batch || batch.messages.at(-1)?.id !== snapshot.at(-1)?.id) return;
    batch.messages = burst;
    if (burst.length < resolveParticipation(current.chat.participation, source.channelId).messagesPerDecision) return;
    const latest = burst.at(-1)!; const trigger = this.trigger(latest); batch.messages = [];
    if (trigger) await this.ambient.execute(latest, trigger, burst);
  }
}
