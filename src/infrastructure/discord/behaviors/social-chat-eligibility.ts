import { allowsDurableWrites, resolveChannelMemoryMode } from "../../../application/memory/memory-channel-policy.js";
import { hashContent } from "../../../application/assets/content-hash.js";
import { PermissionFlagsBits, type GuildMember, type Message } from "discord.js";
import { characterSettings } from "../../../application/chat/character-settings.js";
import type { MessageOriginRecord, MessageOriginStore } from "../../../application/chat/message-origin-store.js";
import { ChatPolicy, type ChatPurpose } from "../../../application/chat/chat-policy.js";
import type { ApplicationConfiguration } from "../../../config/configuration.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { isInGameChannel, type IsGameChannel } from "./game-channel-guard.js";
import { mapWithConcurrency } from "../../../application/concurrency/map-with-concurrency.js";

export interface SocialEligibility { eligible: boolean; reason: string }

// Discord adapter for the common boundary. No model/content heuristics:
// message origins, game ownership and effective access determine eligibility.
export class SocialChatEligibility {
  private readonly recentUtilitySources = new Set<string>();
  private readonly originCache = new Map<string, { expiresAt: number; value: Promise<MessageOriginRecord | null> }>();
  public readonly policy: ChatPolicy;
  private forgottenSource: ((message: Message) => Promise<boolean>) | null = null;
  private forgottenSources: ((messages: readonly Message[]) => Promise<readonly boolean[]>) | null = null;
  public bindGuardedForgetPolicy(check: (message: Message) => Promise<boolean>, batch?: (messages: readonly Message[]) => Promise<readonly boolean[]>): void {
    this.forgottenSource = check; this.forgottenSources = batch ?? null;
  }
  public async sourceForgotten(message: Message): Promise<boolean> { return !this.forgottenSource || await this.forgottenSource(message); }
  public async sourcesForgotten(messages: readonly Message[]): Promise<readonly boolean[]> {
    const result = this.forgottenSources ? await this.forgottenSources(messages) : await mapWithConcurrency(messages, 8, (message) => this.sourceForgotten(message));
    if (result.length !== messages.length || result.some((value) => typeof value !== "boolean")) throw new Error("Incomplete forget policy result.");
    return result;
  }
  public async checkBackgroundSource(message: Message, member: GuildMember | null = message.member): Promise<SocialEligibility> {
    if (this.forgottenSource && await this.forgottenSource(message)) return { eligible: false, reason: "forgotten_source" };
    return this.check(message, "background_observation", member);
  }
  public contextPolicyVersion(message: Message): string {
    const profile = message.guildId ? this.profiles.find(message.guildId) : null;
    return hashContent(JSON.stringify(profile ? { chatbot: profile.features.chatbot, history: profile.features.channelHistory,
      memoryMode: this.contextMemoryMode(message), contextEnabled: characterSettings(profile).channelOverrides[message.channelId]?.contextEnabled !== false } : null));
  }
  public contextMemoryMode(message: Message): string { return resolveChannelMemoryMode(this.profiles.find(message.guildId ?? "")?.chat.channelMemoryModes ?? {}, message.channelId); }
  public hasContextRoleExclusions(source: Message): boolean { return !!(source.guildId && this.profiles.find(source.guildId)?.chat.contextOptOutRoleIds?.length); }
  public async checkGuardedActor(source: Message, member: GuildMember, channelAuthorized = false): Promise<boolean> {
    const profile = source.guildId ? this.profiles.find(source.guildId) : null;
    return !!profile && this.policy.canCollect(profile, { userId: member.id, member }) && (channelAuthorized || await this.canReadHistory(source));
  }
  public canPersistContext(message: Message): boolean {
    const profile = message.guildId ? this.profiles.find(message.guildId) : null;
    return !!profile && allowsDurableWrites(resolveChannelMemoryMode(profile.chat.channelMemoryModes, message.channelId));
  }
  public canShareContext(message: Message): boolean {
    return this.canPersistContext(message) && !!message.guildId && this.profiles.find(message.guildId)?.chat.sharedMemoryEnabled === true;
  }
  public contextRetention(message: Message): "durable" | "session" | "none" {
    const profile = message.guildId ? this.profiles.find(message.guildId) : null;
    if (!profile) return "none";
    const mode = resolveChannelMemoryMode(profile.chat.channelMemoryModes, message.channelId);
    return allowsDurableWrites(mode) ? "durable" : mode === "session_only" ? "session" : "none";
  }
  public async checkGuardedSource(message: Message, member: GuildMember | null, current: boolean, channelAuthorized = false, forgotten?: boolean): Promise<SocialEligibility> {
    const reject = (reason: string): SocialEligibility => ({ eligible: false, reason });
    if (!this.forgottenSource) return reject("forget_policy_unavailable");
    if (!message.inGuild()) return reject("not_guild");
    const profile = this.profiles.find(message.guildId);
    if (!profile) return reject("chat_disabled");
    if (!message.author.bot && !this.policy.canCollect(profile, { userId: message.author.id, member })) return reject("context_opt_out");
    if (!channelAuthorized && !(current ? await this.canUseContextChannel(message) : await this.canReadHistory(message, member))) return reject("passive_scope_denied");
    if (!message.author.bot && (forgotten ?? await this.forgottenSource(message))) return reject("source_forgotten");
    if (!profile.features.chatbot) return reject("chat_disabled");
    if (this.recentUtilitySources.has(`${message.guildId}:${message.channelId}:${message.id}`)) return reject("utility_interaction");
    const origin = await this.findOrigin(message.guildId, message.channelId, message.id, true).catch(() => undefined);
    if (origin === undefined) return reject("origin_lookup_failed");
    if (origin && origin.origin !== "chat") return reject("utility_interaction");
    if (message.author.bot && !origin) return reject("utility_or_unknown_bot_output");
    // Reply ancestry is collected and filtered independently by the context
    // owner. An excluded ancestor must not hide this human's own wording.
    return { eligible: true, reason: "eligible" };
  }
  public constructor(
    configuration: ApplicationConfiguration,
    private readonly profiles: GuildConfigurationProvider,
    private readonly origins: MessageOriginStore,
    private readonly isGameChannel: IsGameChannel | null,
  ) { this.policy = new ChatPolicy(configuration); }

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
    return !!profile && this.policy.canReadBackground(profile, channelId);
  }

  public async canReadHistory(message: Message, member: GuildMember | null = message.member): Promise<boolean> {
    void member;
    if (!message.inGuild()) return false;
    const profile = this.profiles.find(message.guildId);
    return !!profile?.features.chatbot && profile.features.channelHistory &&
      profile.chat.channelMemoryModes[message.channelId] !== "disabled" && characterSettings(profile).channelOverrides[message.channelId]?.contextEnabled !== false &&
      await this.canUseContextChannel(message, true);
  }

  public async canUseContextChannel(message: Message, history = false): Promise<boolean> {
    return !!message.guildId && this.profiles.find(message.guildId)?.features.chatbot === true && this.botCanReadChannel(message, history) &&
      !await isInGameChannel(message, this.isGameChannel);
  }

  public botCanReadChannel(message: Message, history = true): boolean {
    if (!message.inGuild()) return false;
    const me = message.guild?.members.me;
    const permissions = me && message.channel && "permissionsFor" in message.channel ? message.channel.permissionsFor(me) : null;
    return !!permissions?.has(PermissionFlagsBits.ViewChannel) && (!history || permissions.has(PermissionFlagsBits.ReadMessageHistory));
  }

  public collectionPolicyCurrent(message: Message, authorIds: readonly string[], history: boolean, memoryMode: string): boolean {
    const profile = message.guildId ? this.profiles.find(message.guildId) : null;
    if (!profile?.features.chatbot || resolveChannelMemoryMode(profile.chat.channelMemoryModes, message.channelId) !== memoryMode || !this.botCanReadChannel(message, history)) return false;
    if (history && (!profile.features.channelHistory || characterSettings(profile).channelOverrides[message.channelId]?.contextEnabled === false)) return false;
    return authorIds.every((id) => this.policy.canCollect(profile, { userId: id,
      member: message.guild?.members.cache?.get(id) ?? (id === message.author.id ? message.member : null) }));
  }

  // Discord adapter over the common ChatPolicy. Gateway caches carry current
  // roles/permissions; origin, game ownership and source admission are async.
  public admission(message: Message, purpose: ChatPurpose = "direct_mention", member: GuildMember | null = message.member): SocialEligibility {
    if (!message.inGuild()) return { eligible: false, reason: "not_guild" };
    const profile = this.profiles.find(message.guildId);
    if (!profile) return { eligible: false, reason: "chat_disabled" };
    const admission = this.policy.admit(profile, message.channelId, purpose, { userId: message.author.id, bot: message.author.bot, member });
    return admission.admitted ? { eligible: true, reason: "eligible" } : { eligible: false, reason: admission.reason };
  }

  public async check(message: Message, purpose: ChatPurpose = "direct_mention", member: GuildMember | null = message.member): Promise<SocialEligibility> {
    const policy = this.admission(message, purpose, member);
    if (!policy.eligible) return policy;
    const reject = (reason: string): SocialEligibility => ({ eligible: false, reason });
    if (!message.inGuild()) return reject("not_guild");
    if (await isInGameChannel(message, this.isGameChannel)) return reject("game_channel");
    if (this.recentUtilitySources.has(`${message.guildId}:${message.channelId}:${message.id}`)) return reject("utility_interaction");
    const origin = await this.findOrigin(message.guildId, message.channelId, message.id).catch(() => undefined);
    if (origin === undefined) return reject("origin_lookup_failed");
    if (origin && origin.origin !== "chat") return reject("utility_interaction");
    if (message.author.bot && !origin) return reject("utility_or_unknown_bot_output");
    // Admission checks only this event. The common collector owns reply
    // ancestry, filters excluded ancestors and never fetches another channel.
    return { eligible: true, reason: "eligible" };
  }
}
