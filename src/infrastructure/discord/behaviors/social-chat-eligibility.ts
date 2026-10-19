import type { Message } from "discord.js";
import { characterSettings } from "../../../application/chat/character-settings.js";
import type { MessageOriginRecord, MessageOriginStore } from "../../../application/chat/message-origin-store.js";
import { ChatAccessService } from "../../../application/access/chat-access-service.js";
import type { ApplicationConfiguration } from "../../../config/configuration.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { isInGameChannel, type IsGameChannel } from "./game-channel-guard.js";
import { resolveParticipation, passiveChannelAllowed } from "../../../application/chat/participation-policy.js";
import type { ChatRequest } from "../../../application/chat/chat-provider.js";

export type SocialTrigger = ChatRequest["triggerMode"] | "observation" | "background_observation" | "history_reaction" | "history";

export interface HistoricalOriginBudget { remaining: number; resolved: Map<string, Message | null> }

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

  private findOrigin(guildId: string, channelId: string, messageId: string, fresh = false): Promise<MessageOriginRecord | null> {
    if (fresh) return this.origins.find(guildId, channelId, messageId);
    const key = `${guildId}:${channelId}:${messageId}`;
    const cached = this.originCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (this.originCache.size >= 10_000) this.originCache.delete(this.originCache.keys().next().value!);
    const value = this.origins.find(guildId, channelId, messageId);
    this.originCache.set(key, { expiresAt: Date.now() + 15_000, value });
    void value.catch(() => this.originCache.delete(key));
    return value;
  }

  public canReadBackground(guildId: string, channelId: string): boolean {
    const profile = this.profiles.find(guildId);
    return !!profile?.features.chatbot && profile.chat.channelMemoryModes[channelId] !== "disabled" && profile.chat.channelMemoryModes[channelId] !== "session_only" &&
      (profile.chat.contextScanChannelIds.includes(channelId) || profile.chat.contextDailyChannelIds.includes(channelId));
  }

  public async canReadHistory(message: Message): Promise<boolean> {
    if (!message.inGuild()) return false;
    const profile = this.profiles.find(message.guildId);
    return !!profile?.features.chatbot && profile.features.channelHistory && passiveChannelAllowed(profile, message.channelId) &&
      profile.chat.channelMemoryModes[message.channelId] !== "disabled" && characterSettings(profile).channelOverrides[message.channelId]?.contextEnabled !== false &&
      (message.author.bot || this.access.canObserve(profile, message.member)) && !await isInGameChannel(message, this.isGameChannel);
  }

  public async check(message: Message, trigger: SocialTrigger = "direct", historyBudget?: HistoricalOriginBudget): Promise<SocialEligibility> {
    const reject = (reason: string): SocialEligibility => ({ eligible: false, reason });
    if (!message.inGuild()) return reject("not_guild");
    const profile = this.profiles.find(message.guildId);
    if (!profile?.features.chatbot) return reject("chat_disabled");
    if ((trigger === "continuation" || trigger === "spontaneous") && (!profile.features.channelHistory || characterSettings(profile).channelOverrides[message.channelId]?.contextEnabled === false ||
        profile.chat.channelMemoryModes[message.channelId] === "disabled")) return reject("needs_conversation_context");
    const passive = trigger !== "direct" && trigger !== "ambient";
    const background = trigger === "background_observation";
    if (background && !this.canReadBackground(message.guildId, message.channelId)) return reject("background_scope_denied");
    if (passive && !background && (!passiveChannelAllowed(profile, message.channelId) || !profile.features.channelHistory ||
        profile.chat.channelMemoryModes[message.channelId] === "disabled" || characterSettings(profile).channelOverrides[message.channelId]?.contextEnabled === false)) return reject("passive_scope_denied");
    if (passive && !message.author.bot && !this.access.canObserve(profile, message.member)) return reject("passive_access_denied");
    if (await isInGameChannel(message, this.isGameChannel)) return reject("game_channel");
    const participation = resolveParticipation(profile.chat.participation, message.channelId);
    if (trigger === "continuation" && !participation.continuationEnabled) return reject("continuation_disabled");
    if (trigger === "spontaneous" && !participation.spontaneousEnabled) return reject("spontaneous_disabled");
    if (trigger === "history_reaction" && (!profile.features.historyReactions || participation.reactionsEnabled === false)) return reject("history_reactions_disabled");
    if (trigger === "ambient" && !profile.features.ambientReplies) return reject("ambient_disabled");
    if (trigger === "reaction" && !profile.features.reactionReplies) return reject("reaction_disabled");
    // Legacy origin=chat proves the producer, not all sources used to derive
    // the output. Expanded historical reuse fails closed until provenance exists.
    if (trigger === "history" && message.author.bot) return reject("unverifiable_bot_context");
    if (message.author.bot) {
      const origin = await this.findOrigin(message.guildId, message.channelId, message.id).catch(() => null);
      if ((origin && origin.origin !== "chat") || (!origin && trigger !== "direct")) return reject("utility_or_unknown_bot_output");
      if (!passive && profile.channels.chatbot.size > 0 && !profile.channels.chatbot.has(message.channelId)) return reject("channel_denied");
    } else if (!passive && !this.access.canUseMentionChat(profile, message.member, message.author.id, message.channelId)) {
      return reject("access_denied");
    }
    let current: Message = message;
    const visited = new Set<string>();
    for (let depth = 0; depth < (trigger === "observation" || background ? 3 : 20); depth++) {
      if (this.recentUtilitySources.has(`${message.guildId}:${current.channelId}:${current.id}`)) return reject("utility_interaction");
      if (visited.has(current.id)) return reject("cyclic_reply_chain");
      visited.add(current.id);
      const origin = await this.findOrigin(message.guildId, current.channelId, current.id, trigger === "history").catch(() => undefined);
      if (trigger === "history" && origin === undefined) return reject("origin_lookup_failed");
      if (origin && origin.origin !== "chat") return reject("utility_interaction");
      if (current.author.bot && !origin && trigger !== "direct") return reject("unknown_bot_output");
      const targetId = current.reference?.messageId;
      if (!targetId) return { eligible: true, reason: "eligible" };
      const targetChannelId = current.reference?.channelId ?? current.channelId;
      const known = await this.findOrigin(message.guildId, targetChannelId, targetId, trigger === "history").catch(() => undefined);
      if (trigger === "history" && known === undefined) return reject("origin_lookup_failed");
      if (known && known.origin !== "chat") return reject("utility_reply");
      // Do not fetch context across channels with possibly different access.
      if (targetChannelId !== message.channelId) return trigger === "direct" ? { eligible: true, reason: "direct_without_cross_channel_context" } : reject("cross_channel_reply");
      const cachedTarget = current.channel.messages.cache?.get(targetId);
      // Passive observation never walks Discord REST history. Directly
      // addressed requests can proceed when their target was deleted.
      let target: Message | null | undefined;
      if (trigger === "history") {
        // Ignore cache warmth: a single admitted retrieval owns this bounded
        // resolver. Passive observation remains cache-only below.
        if (!historyBudget) return reject("unresolved_reply_origin");
        if (historyBudget.resolved.has(targetId)) target = historyBudget.resolved.get(targetId);
        else {
          if (historyBudget.remaining <= 0) return reject("reply_depth_limit");
          historyBudget.remaining--;
          target = await current.channel.messages.fetch({ message: targetId, force: true }).catch(() => null);
          historyBudget.resolved.set(targetId, target);
        }
      } else target = cachedTarget ?? (trigger === "observation" || background ? null : await current.channel.messages.fetch(targetId).catch(() => null));
      if (!target) return trigger === "direct" ? { eligible: true, reason: "direct_without_reply_context" } : reject("unresolved_reply_origin");
      current = target;
    }
    return reject("reply_depth_limit");
  }
}
