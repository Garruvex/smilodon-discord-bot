import type { Message } from "discord.js";
import type { Logger } from "pino";
import { BehaviorEvent, BehaviorResult, type BotBehavior } from "../../../application/behaviors/behavior.js";
import type { ChatConversationService } from "../../../application/chat/chat-conversation-service.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import type { SocialChatEligibility } from "./social-chat-eligibility.js";
import { ChatTurnSupport } from "./chat-turn-support.js";

export class ConversationObservationBehavior implements BotBehavior<BehaviorEvent.MessageCreated> {
  public readonly id = "conversation-observation";
  public readonly event = BehaviorEvent.MessageCreated;
  public readonly priority = 110;
  private readonly support: ChatTurnSupport;
  public constructor(private readonly conversation: ChatConversationService,
    private readonly profiles: GuildConfigurationProvider, private readonly eligibility: SocialChatEligibility, logger: Logger) {
    this.support = new ChatTurnSupport(logger);
  }
  public async matches(message: Message): Promise<boolean> {
    if (!message.guildId || !this.profiles.find(message.guildId)?.features.channelHistory) return false;
    return message.inGuild() && !message.author.bot && (await this.eligibility.check(message, "observation")).eligible;
  }
  public execute(message: Message): Promise<BehaviorResult> {
    if (message.guildId && this.profiles.find(message.guildId)?.chat.channelMemoryModes[message.channelId] !== "disabled") {
      this.conversation.observe(message.guildId, message.channelId, this.support.toChannelHistoryMessages([message])[0]!);
    }
    return Promise.resolve(BehaviorResult.Continue);
  }
}
