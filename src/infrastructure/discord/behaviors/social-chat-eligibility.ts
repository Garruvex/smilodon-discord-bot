import { allowsDurableWrites, resolveChannelMemoryMode } from "../../../application/memory/memory-channel-policy.js";
import { hashContent } from "../../../application/assets/content-hash.js";
import type { GuildMember, Message } from "discord.js";
import { characterSettings } from "../../../application/chat/character-settings.js";
import type { MessageOriginRecord, MessageOriginStore } from "../../../application/chat/message-origin-store.js";
import { ChatAccessService } from "../../../application/access/chat-access-service.js";
import type { ApplicationConfiguration } from "../../../config/configuration.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { isInGameChannel, type IsGameChannel } from "./game-channel-guard.js";
import { resolveParticipation, passiveChannelAllowed } from "../../../application/chat/participation-policy.js";
import type { ChatRequest } from "../../../application/chat/chat-provider.js";

export type SocialTrigger = ChatRequest["triggerMode"] | "observation" | "background_observation" | "history_reaction" | "history" | "guarded_current";

export interface HistoricalOriginBudget { remaining: number; resolved: Map<string, Message | null> }

export interface SocialEligibility { eligible: boolean; reason: string }

// Discord adapter for the common boundary. No model/content heuristics:
// message origins, game ownership and effective access determine eligibility.
export class SocialChatEligibility {
  private readonly recentUtilitySources = new Set<string>();
  private readonly originCache = new Map<string, { expiresAt: number; value: Promise<MessageOriginRecord | null> }>();
  private readonly access: ChatAccessService;
  private forgottenSource: ((message: Message) => Promise<boolean>) | null = null;
  public bindGuardedForgetPolicy(check: (message: Message) => Promise<boolean>): void { this.forgottenSource = check; }
  public async checkBackgroundSource(message: Message, member: GuildMember | null = message.member): Promise<SocialEligibility> {
    if (this.forgottenSource && await this.forgottenSource(message)) return { eligible: false, reason: "forgotten_source" };
    return this.check(message, "background_observation", undefined, member);
  }
  public contextPolicyVersion(message: Message): string {
    const profile = message.guildId ? this.profiles.find(message.guildId) : null;
    return hashContent(JSON.stringify(profile, (_key, value: unknown) => value instanceof Set ? [...value].sort() : value));
  }
  public async checkGuardedActor(source: Message, member: GuildMember): Promise<boolean> {
    const profile = source.guildId ? this.profiles.find(source.guildId) : null;
    return !!profile && this.access.canObserve(profile, member) && await this.canReadHistory(source);
  }
  public canPersistContext(message: Message): boolean {
    const profile = message.guildId ? this.profiles.find(message.guildId) : null;
    return !!profile && allowsDurableWrites(resolveChannelMemoryMode(profile.chat.channelMemoryModes, message.channelId));
  }
  public canShareContext(message: Message): boolean {
    return this.canPersistContext(message) && !!message.guildId && this.profiles.find(message.guildId)?.chat.sharedMemoryEnabled === true;
  }
  public async checkGuardedSource(message: Message, member: GuildMember | null, current: boolean): Promise<SocialEligibility> {
    const reject = (reason: string): SocialEligibility => ({ eligible: false, reason });
    if (!this.forgottenSource) return reject("forget_policy_unavailable");
    if (!message.inGuild()) return reject("not_guild");
    const profile = this.profiles.find(message.guildId);
    if (!profile) return reject("chat_disabled");
    if (!message.author.bot && !current && !this.access.canObserve(profile, member)) return reject("passive_access_denied");
    if (!current && !await this.canReadHistory(message, member)) return reject("passive_scope_denied");
    if (!message.author.bot && await this.forgottenSource(message)) return reject("source_forgotten");
    return this.check(message, "guarded_current", undefined, member);
  }
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

  public async canReadHistory(message: Message, member: GuildMember | null = message.member): Promise<boolean> {
    if (!message.inGuild()) return false;
    const profile = this.profiles.find(message.guildId);
    return !!profile?.features.chatbot && profile.features.channelHistory && passiveChannelAllowed(profile, message.channelId) &&
      profile.chat.channelMemoryModes[message.channelId] !== "disabled" && characterSettings(profile).channelOverrides[message.channelId]?.contextEnabled !== false &&
      (message.author.bot || this.access.canObserve(profile, member)) && !await isInGameChannel(message, this.isGameChannel);
  }

  public async check(message: Message, trigger: SocialTrigger = "direct", historyBudget?: HistoricalOriginBudget, member: GuildMember | null = message.member): Promise<SocialEligibility> {
    const reject = (reason: string): SocialEligibility => ({ eligible: false, reason });
    if (!message.inGuild()) return reject("not_guild");
    const profile = this.profiles.find(message.guildId);
    if (!profile?.features.chatbot) return reject("chat_disabled");
    if ((trigger === "continuation" || trigger === "spontaneous") && (!profile.features.channelHistory || characterSettings(profile).channelOverrides[message.channelId]?.contextEnabled === false ||
        profile.chat.channelMemoryModes[message.channelId] === "disabled")) return reject("needs_conversation_context");
    const passive = trigger !== "direct" && trigger !== "ambient" && trigger !== "guarded_current";
    const background = trigger === "background_observation";
    if (background && !this.canReadBackground(message.guildId, message.channelId)) return reject("background_scope_denied");
    if (passive && !background && (!passiveChannelAllowed(profile, message.channelId) || !profile.features.channelHistory ||
        profile.chat.channelMemoryModes[message.channelId] === "disabled" || characterSettings(profile).channelOverrides[message.channelId]?.contextEnabled === false)) return reject("passive_scope_denied");
    if (passive && !message.author.bot && !this.access.canObserve(profile, member)) return reject("passive_access_denied");
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
    } else if (!passive && !this.access.canUseMentionChat(profile, member, message.author.id, message.channelId)) {
      return reject("access_denied");
    }
    let current: Message = message;
    const visited = new Set<string>();
    for (let depth = 0; depth < (trigger === "observation" || background ? 3 : 20); depth++) {
      if (this.recentUtilitySources.has(`${message.guildId}:${current.channelId}:${current.id}`)) return reject("utility_interaction");
      if (visited.has(current.id)) return reject("cyclic_reply_chain");
      visited.add(current.id);
      const origin = await this.findOrigin(message.guildId, current.channelId, current.id, trigger === "history" || trigger === "guarded_current").catch(() => undefined);
      if ((trigger === "history" || trigger === "guarded_current") && origin === undefined) return reject("origin_lookup_failed");
      if (origin && origin.origin !== "chat") return reject("utility_interaction");
      if (current.author.bot && !origin && trigger !== "direct") return reject("unknown_bot_output");
      const targetId = current.reference?.messageId;
      if (!targetId) return { eligible: true, reason: "eligible" };
      const targetChannelId = current.reference?.channelId ?? current.channelId;
      const known = await this.findOrigin(message.guildId, targetChannelId, targetId, trigger === "history" || trigger === "guarded_current").catch(() => undefined);
      if ((trigger === "history" || trigger === "guarded_current") && known === undefined) return reject("origin_lookup_failed");
      if (known && known.origin !== "chat") return reject("utility_reply");
      // Do not fetch context across channels with possibly different access.
      if (targetChannelId !== message.channelId) return trigger === "direct" || trigger === "guarded_current" ? { eligible: true, reason: "direct_without_cross_channel_context" } : reject("cross_channel_reply");
      if (trigger === "guarded_current" || (trigger === "direct" || trigger === "ambient") && characterSettings(profile).context.retrievalMode === "eligible_count")
        return { eligible: true, reason: "eligible" };
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
