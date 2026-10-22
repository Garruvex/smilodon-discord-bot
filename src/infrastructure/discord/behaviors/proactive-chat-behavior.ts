import type { Message } from "discord.js";
import type { Logger } from "pino";
import { BehaviorEvent, BehaviorResult, type BotBehavior } from "../../../application/behaviors/behavior.js";
import type { ChatConversationService } from "../../../application/chat/chat-conversation-service.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../../../config/guild-configuration.js";
import { resolveParticipation } from "../../../application/chat/participation-policy.js";
import { passiveScopeReasons } from "../../../application/chat/chat-policy.js";
import { addressesBotName } from "../../../domain/chat/name-mention.js";
import type { SocialChatEligibility } from "./social-chat-eligibility.js";
import type { AmbientChatBehavior } from "./ambient-chat-behavior.js";
import { ContextualCandidateBuffer } from "./contextual-candidate-buffer.js";

type OptionalTrigger = "implicit_followup" | "group_conversation";
export class ProactiveChatBehavior implements BotBehavior<BehaviorEvent.MessageCreated> {
  private readonly candidates: ContextualCandidateBuffer;
  public readonly id = "proactive-chat";
  public readonly event = BehaviorEvent.MessageCreated;
  public readonly priority = 80;
  public constructor(private readonly botId: () => string | null,
    private readonly profiles: GuildConfigurationProvider, conversation: ChatConversationService,
    private readonly eligibility: SocialChatEligibility, ambient: AmbientChatBehavior, logger: Logger) {
    this.candidates = new ContextualCandidateBuffer(logger, {
      fingerprint: (message): string | null => { const profile = message.guildId ? profiles.find(message.guildId) : null; return profile
        ? this.fingerprint(profile, message.channelId) + conversation.optionalOpportunityVersion(message.guildId!, message.channelId) : null; },
      delay: (message): number => conversation.optionalEvaluationDelayMs(message.guildId!, message.channelId, resolveParticipation(profiles.find(message.guildId!)?.chat.participation, message.channelId).limits),
      threshold: (message): number => resolveParticipation(profiles.find(message.guildId!)?.chat.participation, message.channelId).messagesPerDecision,
      eligible: async (message): Promise<boolean> => { const trigger = this.trigger(message); return trigger !== null && (await eligibility.check(message, trigger)).eligible; },
      schedule: (message, work): void => conversation.bufferOpportunity(message.guildId!, message.channelId, work),
      evaluate: async (message, burst, candidateId): Promise<void> => { const trigger = this.trigger(message); if (trigger) await ambient.execute(message, trigger, burst, candidateId); },
    });
  }

  private fingerprint(profile: GuildConfiguration, channelId: string): string {
    return JSON.stringify([profile.chat.participation, profile.features.chatbot, profile.features.channelHistory, profile.character,
      profile.chat.channelMemoryModes[channelId], [...profile.channels.chatbot], [...profile.roles.chatbot], [...profile.roles.botAdministrator], [...profile.roles.restricted]]);
  }
  // Routing only: explicit addresses belong to the mention and name behaviors,
  // and every other message becomes one neutral candidate. Whether a decision
  // model is configured, and what the message means, is the decision stage's job.
  private trigger(message: Message): OptionalTrigger | null {
    const botId = this.botId();
    const profile = message.guildId ? this.profiles.find(message.guildId) : null;
    if (!botId || !profile || !profile.features.chatbot || passiveScopeReasons(profile, message.channelId, false).length > 0 ||
        !message.inGuild() || message.author.bot || message.mentions.users.has(botId)) return null;
    if (addressesBotName(message.content, profile.displayName) || message.mentions.repliedUser?.id === botId ||
        message.reference?.messageId && message.channel?.messages?.cache?.get(message.reference.messageId)?.author.id === botId) return null;
    if (!message.content.trim() && !(message.attachments?.size ?? 0)) return null;
    const policy = resolveParticipation(profile.chat.participation, message.channelId);
    return policy.spontaneousEnabled ? "group_conversation" : policy.continuationEnabled ? "implicit_followup" : null;
  }
  public async matches(message: Message): Promise<boolean> {
    const trigger = this.trigger(message);
    const eligible = trigger !== null && (await this.eligibility.check(message, trigger)).eligible;
    if (!eligible && trigger === null && message.guildId && !message.author.bot) this.candidates.cancel(message);
    return eligible;
  }
  public async execute(message: Message): Promise<BehaviorResult> {
    const trigger = this.trigger(message);
    if (trigger && (await this.eligibility.check(message, trigger)).eligible) this.candidates.add(message);
    return BehaviorResult.Continue;
  }
}
