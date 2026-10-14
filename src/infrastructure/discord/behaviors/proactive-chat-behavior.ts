import type { Message } from "discord.js";
import type { Logger } from "pino";
import { BehaviorEvent, BehaviorResult, type BotBehavior } from "../../../application/behaviors/behavior.js";
import type { ChatConversationService } from "../../../application/chat/chat-conversation-service.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { resolveParticipation } from "../../../application/chat/participation-policy.js";
import { containsBotName } from "../../../domain/chat/name-mention.js";
import type { SocialChatEligibility } from "./social-chat-eligibility.js";
import type { AmbientChatBehavior } from "./ambient-chat-behavior.js";

export class ProactiveChatBehavior implements BotBehavior<BehaviorEvent.MessageCreated> {
  public readonly id = "proactive-chat";
  public readonly event = BehaviorEvent.MessageCreated;
  public readonly priority = 80;
  public constructor(private readonly botId: () => string | null,
    private readonly profiles: GuildConfigurationProvider, private readonly conversation: ChatConversationService,
    private readonly eligibility: SocialChatEligibility, private readonly ambient: AmbientChatBehavior, private readonly logger: Logger) {}

  private trigger(message: Message): "continuation" | "spontaneous" | null {
    const botId = this.botId();
    const profile = message.guildId ? this.profiles.find(message.guildId) : null;
    if (!botId || !profile || !message.inGuild() || message.author.bot || message.mentions.users.has(botId)) return null;
    if (containsBotName(message.content, profile.displayName)) return null;
    const policy = resolveParticipation(profile.chat.participation, message.channelId);
    if (policy.continuationEnabled && this.conversation.hasRecentConversation(message.guildId, message.channelId, message.author.id, botId)) return "continuation";
    return policy.spontaneousEnabled && message.content.trim().length >= 12 ? "spontaneous" : null;
  }
  public async matches(message: Message): Promise<boolean> {
    const trigger = this.trigger(message);
    return trigger !== null && (await this.eligibility.check(message, trigger)).eligible;
  }
  public execute(message: Message): Promise<BehaviorResult> {
    this.conversation.bufferOpportunity(message.guildId!, message.channelId, () => {
      const trigger = this.trigger(message);
      if (!trigger) return;
      void this.ambient.execute(message, trigger).catch((error: unknown) =>
        this.logger.warn({ error, guildId: message.guildId, channelId: message.channelId }, "Optional participation failed"));
    });
    return Promise.resolve(BehaviorResult.Continue);
  }
}
