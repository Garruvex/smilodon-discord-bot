import type { Message } from "discord.js";
import type { Logger } from "pino";
import { BehaviorEvent, BehaviorResult, type BotBehavior } from "../../../application/behaviors/behavior.js";
import type { ChatConversationService } from "../../../application/chat/chat-conversation-service.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { resolveParticipation } from "../../../application/chat/participation-policy.js";
import { characterSettings } from "../../../application/chat/character-settings.js";
import { containsBotName } from "../../../domain/chat/name-mention.js";
import type { SocialChatEligibility } from "./social-chat-eligibility.js";
import type { AmbientChatBehavior } from "./ambient-chat-behavior.js";

export class ProactiveChatBehavior implements BotBehavior<BehaviorEvent.MessageCreated> {
  private readonly bursts = new Map<string, Message[]>();
  public readonly id = "proactive-chat";
  public readonly event = BehaviorEvent.MessageCreated;
  public readonly priority = 80;
  public constructor(private readonly botId: () => string | null,
    private readonly profiles: GuildConfigurationProvider, private readonly conversation: ChatConversationService,
    private readonly eligibility: SocialChatEligibility, private readonly ambient: AmbientChatBehavior, private readonly logger: Logger) {}

  private trigger(message: Message): "continuation" | "spontaneous" | null {
    const botId = this.botId();
    const profile = message.guildId ? this.profiles.find(message.guildId) : null;
    if (!botId || !profile || !profile.features.channelHistory || characterSettings(profile).channelOverrides[message.channelId]?.contextEnabled === false ||
        profile.chat.channelMemoryModes[message.channelId] === "disabled" || !message.inGuild() || message.author.bot || message.mentions.users.has(botId)) return null;
    if (containsBotName(message.content, profile.displayName)) return null;
    const policy = resolveParticipation(profile.chat.participation, message.channelId);
    if (policy.continuationEnabled && (this.conversation.hasRecentConversation(message.guildId, message.channelId, message.author.id, botId) ||
      this.conversation.isImplicitlyAddressed(message.guildId, message.channelId, { messageId: message.id, timestampMs: message.createdTimestamp,
        authorId: message.author.id, authorDisplayName: message.author.displayName, content: message.content, imageCount: 0,
        replyToMessageId: message.reference?.messageId ?? null }, botId))) return "continuation";
    return policy.spontaneousEnabled && (message.content.trim().length >= 12 || this.bursts.has(`${message.guildId}:${message.channelId}`)) ? "spontaneous" : null;
  }
  public async matches(message: Message): Promise<boolean> {
    const trigger = this.trigger(message);
    return trigger !== null && (await this.eligibility.check(message, trigger)).eligible;
  }
  public execute(message: Message): Promise<BehaviorResult> {
    const key = `${message.guildId}:${message.channelId}`;
    if (this.bursts.size >= 256 && !this.bursts.has(key)) this.bursts.delete(this.bursts.keys().next().value!);
    this.bursts.set(key, [...(this.bursts.get(key) ?? []).filter((item) => Date.now() - item.createdTimestamp <= 10_000), message].slice(-20));
    this.conversation.bufferOpportunity(message.guildId!, message.channelId, () => {
      const burst = this.bursts.get(key) ?? [message];
      const trigger = burst.some((item) => this.trigger(item) === "continuation") ? "continuation" : this.trigger(message);
      this.bursts.delete(key);
      if (!trigger) return;
      void this.ambient.execute(message, trigger, burst).catch((error: unknown) =>
        this.logger.warn({ error, guildId: message.guildId, channelId: message.channelId }, "Optional participation failed"));
    });
    return Promise.resolve(BehaviorResult.Continue);
  }
}
