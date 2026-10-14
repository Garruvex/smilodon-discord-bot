import type { Message } from "discord.js";
import { characterSettings } from "../../../application/chat/character-settings.js";
import type { MessageOriginRecord, MessageOriginStore } from "../../../application/chat/message-origin-store.js";
import { ChatAccessService } from "../../../application/access/chat-access-service.js";
import type { ApplicationConfiguration } from "../../../config/configuration.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { isInGameChannel, type IsGameChannel } from "./game-channel-guard.js";
import { resolveParticipation } from "../../../application/chat/participation-policy.js";
import type { ChatRequest } from "../../../application/chat/chat-provider.js";

export type SocialTrigger = ChatRequest["triggerMode"] | "observation" | "history_reaction";

export interface SocialEligibility { eligible: boolean; reason: string }

// Discord adapter for the common boundary. No model/content heuristics:
// message origins, game ownership and effective access determine eligibility.
export class SocialChatEligibility {
  private readonly recentUtilitySources = new Set<string>();
  private readonly originCache = new Map<string, { expiresAt: number; value: Promise<MessageOriginRecord | null> }>();
  private readonly access: ChatAccessService;
  public constructor(
    configuration: ApplicationConfiguration,
    private readonly profiles: GuildConfigurationProvider,
    private readonly origins: MessageOriginStore,
    private readonly isGameChannel: IsGameChannel | null,
  ) { this.access = new ChatAccessService(configuration); }

  public markUtilitySource(message: Message): void {
    this.originCache.delete(`${message.guildId}:${message.channelId}:${message.id}`);
    if (this.recentUtilitySources.size >= 10_000) this.recentUtilitySources.delete(this.recentUtilitySources.values().next().value!);
    this.recentUtilitySources.add(`${message.guildId}:${message.channelId}:${message.id}`);
  }

  private findOrigin(guildId: string, channelId: string, messageId: string): Promise<MessageOriginRecord | null> {
    const key = `${guildId}:${channelId}:${messageId}`;
    const cached = this.originCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (this.originCache.size >= 10_000) this.originCache.delete(this.originCache.keys().next().value!);
    const value = this.origins.find(guildId, channelId, messageId);
    this.originCache.set(key, { expiresAt: Date.now() + 15_000, value });
    void value.catch(() => this.originCache.delete(key));
    return value;
  }

  public async check(message: Message, trigger: SocialTrigger = "direct"): Promise<SocialEligibility> {
    const reject = (reason: string): SocialEligibility => ({ eligible: false, reason });
    if (!message.inGuild()) return reject("not_guild");
    const profile = this.profiles.find(message.guildId);
    if (!profile?.features.chatbot) return reject("chat_disabled");
    if ((trigger === "continuation" || trigger === "spontaneous") && (!profile.features.channelHistory || characterSettings(profile).channelOverrides[message.channelId]?.contextEnabled === false ||
        profile.chat.channelMemoryModes[message.channelId] === "disabled")) return reject("needs_conversation_context");
    if (await isInGameChannel(message, this.isGameChannel)) return reject("game_channel");
    const participation = resolveParticipation(profile.chat.participation, message.channelId);
    if (trigger === "continuation" && !participation.continuationEnabled) return reject("continuation_disabled");
    if (trigger === "spontaneous" && !participation.spontaneousEnabled) return reject("spontaneous_disabled");
    if (trigger === "history_reaction" && (!profile.features.historyReactions || participation.reactionsEnabled === false)) return reject("history_reactions_disabled");
    if (trigger === "ambient" && !profile.features.ambientReplies) return reject("ambient_disabled");
    if (trigger === "reaction" && !profile.features.reactionReplies) return reject("reaction_disabled");
    if (message.author.bot) {
      const origin = await this.findOrigin(message.guildId, message.channelId, message.id).catch(() => null);
      if ((origin && origin.origin !== "chat") || (!origin && trigger !== "direct")) return reject("utility_or_unknown_bot_output");
      if (profile.channels.chatbot.size > 0 && !profile.channels.chatbot.has(message.channelId)) return reject("channel_denied");
    } else if (!this.access.canUseMentionChat(profile, message.member, message.author.id, message.channelId)) {
      return reject("access_denied");
    }
    let current = message;
    const visited = new Set<string>();
    for (let depth = 0; depth < (trigger === "observation" ? 3 : 20); depth++) {
      if (this.recentUtilitySources.has(`${message.guildId}:${current.channelId}:${current.id}`)) return reject("utility_interaction");
      if (visited.has(current.id)) return reject("cyclic_reply_chain");
      visited.add(current.id);
      const origin = await this.findOrigin(message.guildId, current.channelId, current.id).catch(() => null);
      if (origin && origin.origin !== "chat") return reject("utility_interaction");
      if (current.author.bot && !origin && trigger !== "direct") return reject("unknown_bot_output");
      const targetId = current.reference?.messageId;
      if (!targetId) return { eligible: true, reason: "eligible" };
      const targetChannelId = current.reference?.channelId ?? current.channelId;
      const known = await this.findOrigin(message.guildId, targetChannelId, targetId).catch(() => null);
      if (known && known.origin !== "chat") return reject("utility_reply");
      // Do not fetch context across channels with possibly different access.
      if (targetChannelId !== message.channelId) return trigger === "direct" ? { eligible: true, reason: "direct_without_cross_channel_context" } : reject("cross_channel_reply");
      const cachedTarget = current.channel.messages.cache?.get(targetId);
      // Passive observation never walks Discord REST history. Directly
      // addressed requests can proceed when their target was deleted.
      const target = cachedTarget ?? (trigger === "observation" ? null : await current.channel.messages.fetch(targetId).catch(() => null));
      if (!target) return trigger === "direct" ? { eligible: true, reason: "direct_without_reply_context" } : reject("unresolved_reply_origin");
      current = target;
    }
    return reject("reply_depth_limit");
  }
}
