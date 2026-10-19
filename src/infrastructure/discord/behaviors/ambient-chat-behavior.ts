import type { Message } from "discord.js";
import type { Logger } from "pino";
import { SocialOutputSuppressed, type MessageOriginStore } from "../../../application/chat/message-origin-store.js";
import type { SocialChatEligibility } from "./social-chat-eligibility.js";
import { resolveParticipation } from "../../../application/chat/participation-policy.js";
import { characterSettings } from "../../../application/chat/character-settings.js";
import { resolveChannelMemoryMode } from "../../../application/memory/memory-channel-policy.js";

import { ChatAccessService } from "../../../application/access/chat-access-service.js";
import { BehaviorEvent, BehaviorResult, type BotBehavior } from "../../../application/behaviors/behavior.js";
import { chatMemoryLimits } from "../../../application/chat/chat-memory-policy.js";
import type { ChannelHistoryMessage, ReplyChainMessage } from "../../../application/chat/chat-provider.js";
import type { ChatConversationService } from "../../../application/chat/chat-conversation-service.js";
import type { PersonaSource } from "../../../application/chat/persona-source.js";
import type { ApplicationConfiguration } from "../../../config/configuration.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { addressesBotName } from "../../../domain/chat/name-mention.js";
import type { MessageReactionWatchStore } from "../../../application/chat/message-reaction-watch.js";
import { ChatTurnSupport } from "./chat-turn-support.js";
import { isInGameChannel, type IsGameChannel } from "./game-channel-guard.js";

// Handles messages that merely name the bot (per its configured
// branding.displayName) without an explicit @mention. Unlike
// MentionChatBehavior, which always replies, here the model itself judges
// whether to reply, react with an emoji, both, or neither — see triggerMode
// "ambient" on ChatRequest and ChatConversationService's short-circuit for
// non-"reply" outcomes. Opt-in per guild via features.ambientReplies.
export class AmbientChatBehavior implements BotBehavior<BehaviorEvent.MessageCreated> {
  public readonly id = "ambient-chat";
  public readonly event = BehaviorEvent.MessageCreated;
  // Lower than MentionChatBehavior's 100, so an explicit @mention always
  // wins if a message somehow matched both (in practice it can't: matches()
  // below explicitly defers to an existing @mention).
  public readonly priority = 90;
  private readonly chatAccess: ChatAccessService;
  private readonly turnSupport: ChatTurnSupport;
  private readonly cooldownUntilByChannel = new Map<string, number>();

  public constructor(
    private readonly clientUserId: () => string | null,
    private readonly configuration: ApplicationConfiguration,
    private readonly profiles: GuildConfigurationProvider,
    private readonly conversation: ChatConversationService | null,
    private readonly personaSource: PersonaSource,
    private readonly logger: Logger,
    // See MentionChatBehavior's own doc comment on this same param.
    private readonly messageReactionWatchStore: MessageReactionWatchStore | null = null,
    // The narrator owns a D&D game's channels; chat stays out of them.
    private readonly isGameChannel: IsGameChannel | null = null,
    eligibility: SocialChatEligibility | null = null,
    origins: MessageOriginStore | null = null,
  ) {
    this.chatAccess = new ChatAccessService(configuration);
    this.turnSupport = new ChatTurnSupport(logger, eligibility, origins, (message) => {
      if (message.guildId) this.conversation?.excludeInteraction(message.guildId, message.channelId, message.id);
    });
  }

  public async matches(message: Message): Promise<boolean> {
    const botId = this.clientUserId();
    if (!botId || !message.inGuild() || message.author.bot) return false;
    // An explicit @mention is MentionChatBehavior's job, always answered in
    // full — never re-judged here.
    if (message.mentions.users.has(botId)) return false;
    const profile = this.profiles.find(message.guildId);
    if (!profile) return false;
    // `named` is computed before the feature/access/cooldown gates below so
    // those gates can log a debug reason only when the bot's name was
    // actually said — logging on every unrelated message would be too
    // noisy to be useful.
    const liveNickname = message.guild.members.me?.nickname ?? message.guild.members.me?.displayName;
    const named =
      addressesBotName(message.content, profile.displayName) ||
      (liveNickname ? addressesBotName(message.content, liveNickname) : false);
    if (!named) return false;
    const logContext = { guildId: message.guildId, channelId: message.channelId, messageId: message.id };
    if (!profile.features.chatbot || !profile.features.ambientReplies) {
      this.logger.debug(logContext, "Ambient chat: name mentioned but ambientReplies feature is disabled for this guild");
      return false;
    }
    if (!this.conversation) {
      this.logger.debug(logContext, "Ambient chat: name mentioned but no conversation service is configured");
      return false;
    }
    if (!this.chatAccess.canUseMentionChat(profile, message.member, message.author.id, message.channelId)) {
      this.logger.debug(logContext, "Ambient chat: name mentioned but access policy denied this user/channel");
      return false;
    }
    if (await isInGameChannel(message, this.isGameChannel)) {
      this.logger.debug(logContext, "Ambient chat: name mentioned in a D&D game channel, which the narrator owns");
      return false;
    }
    const cooldownUntil = this.cooldownUntilByChannel.get(message.channelId) ?? 0;
    if (!await this.turnSupport.isEligible(message, "ambient")) return false;
    if (Date.now() < cooldownUntil) {
      this.logger.debug(
        { ...logContext, cooldownRemainingMs: cooldownUntil - Date.now() },
        "Ambient chat: name mentioned but channel is on cooldown",
      );
      return false;
    }
    return true;
  }

  public async execute(message: Message, trigger: "ambient" | "continuation" | "spontaneous" = "ambient", burst: readonly Message[] = []): Promise<BehaviorResult> {
    if (trigger === "ambient" && message.guildId) this.conversation?.cancelOptionalOpportunity?.(message.guildId, message.channelId, "addressed_request");
    const opportunityVersion = trigger === "ambient" || !message.guildId ? null : this.conversation?.optionalOpportunityVersion?.(message.guildId, message.channelId);
    if (!message.inGuild() || !this.conversation) return BehaviorResult.Continue;
    const profile = this.profiles.find(message.guildId);
    if (!profile) return BehaviorResult.Continue;
    if (!await this.turnSupport.isEligible(message, trigger)) return BehaviorResult.Continue;
    const participation = resolveParticipation(profile.chat.participation, message.channelId);
    if (trigger === "ambient") this.cooldownUntilByChannel.set(
      message.channelId,
      Date.now() + profile.chat.ambientCooldownSeconds * 1_000,
    );

    const { kept: replyChainMessages, overflow: replyChainOverflowMessages } = await this.turnSupport.resolveReplyChain(message);
    const ancestors = this.turnSupport.toChannelHistoryMessages([...replyChainOverflowMessages, ...replyChainMessages]);
    const replyChain: ReplyChainMessage[] = ancestors.slice(replyChainOverflowMessages.length);
    // Older ancestors are summarized without attaching their images. Preserve
    // their original authors/addressees even when another human joins a reply.
    const replyChainOverflow: ReplyChainMessage[] = ancestors.slice(0, replyChainOverflowMessages.length)
      .map((hop) => ({ ...hop, imageCount: 0 }));
    const channelHistory: ChannelHistoryMessage[] = profile.features.channelHistory
      ? this.turnSupport.toChannelHistoryMessages(await this.turnSupport.resolveChannelHistory(
          message,
          characterSettings(profile).context.enabled ? characterSettings(profile).context.maxMessages : profile.chat.channelHistoryLimit,
          new Set(replyChainMessages.map((hop) => hop.id)),
          undefined, characterSettings(profile).context.enabled ? characterSettings(profile).context.budget : chatMemoryLimits.maxChannelHistoryChars,
        ))
      : [];
    const { selected: imageAttachments, droppedUnsupported, droppedOverLimit } = profile.chat.imageInputEnabled
      ? this.turnSupport.selectImageAttachments(
          [...message.attachments.values()],
          [...replyChainMessages].reverse().map((hop) => [...hop.attachments.values()]),
          profile.chat.maxImagesPerRequest,
        )
      : { selected: [], droppedUnsupported: 0, droppedOverLimit: 0 };

    const mentionedUsers = message.mentions.users
      .filter((user) => !user.bot && user.id !== message.author.id)
      .map((user) => ({
        ...this.turnSupport.toChatUser(user, message.mentions.members?.get(user.id) ?? null),
        id: user.id,
        displayName: message.mentions.members?.get(user.id)?.displayName ?? user.displayName,
        roleNames: message.mentions.members?.get(user.id)?.roles.cache
          .filter((role) => role.id !== message.guildId)
          .map((role) => role.name.slice(0, 50))
          .slice(0, 10) ?? [],
      }));

    let textDelivered = false;
    try {
      const { images } = await this.turnSupport.loadImages(imageAttachments);
      const musicActor = this.turnSupport.resolveMusicActor(message, profile);
      const persona = await this.personaSource.resolve(profile);
      const response = await this.conversation.run({
        guildId: message.guildId,
        channelId: message.channelId,
        sourceMessageId: message.id,
        channelHistoryEnabled: profile.features.channelHistory,
        currentEvent: this.turnSupport.toMessageEvent(message), botUserId: this.clientUserId(),
        canExecute: async () => (opportunityVersion == null || this.conversation?.optionalOpportunityVersion(message.guildId, message.channelId) === opportunityVersion) && await this.turnSupport.isEligible(message, trigger),
        activityLimits: participation.limits, shadowMode: participation.shadowMode,
        resolveActivityLimits: () => resolveParticipation(this.profiles.find(message.guildId)?.chat.participation, message.channelId).limits,
        resolveMemoryMode: () => resolveChannelMemoryMode(this.profiles.find(message.guildId)?.chat.channelMemoryModes ?? {}, message.channelId),
        refreshContextMessage: (event) => this.turnSupport.refreshHistoryEvent(message, event),
        shouldDeliver: () => (opportunityVersion == null || this.conversation?.optionalOpportunityVersion(message.guildId, message.channelId) === opportunityVersion) && !resolveParticipation(this.profiles.find(message.guildId)?.chat.participation, message.channelId).shadowMode,
        afterDecision: async (result) => {
          if (result.characterIsCurrent && !result.characterIsCurrent() || result.characterCanDeliver && !await result.characterCanDeliver()) return;
          const reactionTarget = result.replyTargetMessageId && result.replyTargetMessageId !== message.id
            ? await message.channel.messages.fetch(result.replyTargetMessageId).catch(() => null) : message;
          const reserve = (): ((success: boolean) => void) | null => this.conversation!.reserveReaction(message.guildId, message.channelId,
            resolveParticipation(this.profiles.find(message.guildId)?.chat.participation, message.channelId).limits);
          if (result.reactionEmoji && reactionTarget && await this.turnSupport.isEligible(reactionTarget, "history_reaction")) {
            const release = reserve();
            if (release) { try { await reactionTarget.react(result.reactionEmoji); release(true); } catch { release(false); } }
          }
          await this.turnSupport.applyHistoryReactions(message.channel, result.historyReactions,
            { guildId: message.guildId, sourceMessageId: message.id }, reserve);
        },
        personality: persona.personality,
        examplePool: persona.examplePool,
        loreChunks: persona.loreChunks,
        personaDrift: persona.personaDrift,
        personaDriftEnabled: profile.chat.personaDriftEnabled,
        personalitySourceHash: persona.personalitySourceHash,
        currentUser: {
          ...this.turnSupport.toChatUser(message.author, message.member),
          id: message.author.id,
          displayName: message.member?.displayName ?? message.author.username,
          roleNames: message.member?.roles.cache
            .filter((role) => role.id !== message.guildId)
            .map((role) => role.name.slice(0, 50))
            .slice(0, 10) ?? [],
        },
        mentionedUsers,
        currentBurst: this.turnSupport.toChannelHistoryMessages((await Promise.all(burst.map(async (item) =>
          await this.turnSupport.isEligible(item, trigger) ? item : null))).filter((item): item is Message => item !== null)).map((event) => ({ ...event, content: event.content.slice(0, 500) })),
        message: message.content,
        replyChain,
        replyChainOverflow,
        channelHistory,
        images,
        webSearchMode: profile.chat.webSearchMode,
        imageGenerationEnabled: trigger === "ambient" && !participation.shadowMode && profile.chat.imageGenerationEnabled,
        includeSources: profile.chat.includeSources,
        triggerMode: trigger,
        historyReactionsEnabled: profile.features.historyReactions && profile.features.channelHistory,
        toolsEnabled: !participation.shadowMode && profile.chat.toolCallingEnabled,
        ...(trigger === "ambient" ? {} : { allowedToolNames: new Set(["lookup_discord_server"]) }),
        disabledToolNames: new Set(profile.chat.disabledTools),
        channelMemoryModes: profile.chat.channelMemoryModes,
        isOwner: this.configuration.ownerUserIds.has(message.author.id),
        channelIsNsfw: "nsfw" in message.channel ? Boolean(message.channel.nsfw) : false,
        musicActor: musicActor?.actor ?? null,
        musicResolveAccessSubjectFields: musicActor?.resolveAccessSubjectFields,
        musicVolumeMaximum: musicActor?.volumeMaximum,
        musicControllerRoleIds: musicActor?.musicControllerRoleIds,
        musicBotAdministratorRoleIds: musicActor?.botAdministratorRoleIds,
      }, async (deliveredResponse) => {
        const target = deliveredResponse.replyTargetMessageId && deliveredResponse.replyTargetMessageId !== message.id
          ? await message.channel.messages.fetch(deliveredResponse.replyTargetMessageId).catch(() => null) : message;
        if (!target || !await this.turnSupport.isEligible(target, trigger)) throw new SocialOutputSuppressed();
        const emptyFallbackContent = deliveredResponse.generatedImages.length > 0
          ? "Here you go!"
          : "I ran out of words. Very premium of me.";
        const { deliveredText, firstMessageId } = await this.turnSupport.deliverChatResponse({
          sourceMessage: target, trigger, origin: deliveredResponse.outputOrigin ?? "chat",
          sender: {
            first: (payload) => trigger !== "ambient" && target.id === message.id ? message.channel.send({ content: payload.content, files: [...payload.files], allowedMentions: { parse: [] } }) : target.reply({
              content: payload.content,
              files: [...payload.files],
              allowedMentions: { repliedUser: false, parse: [] },
            }),
            rest: (payload) => message.channel.send({
              content: payload.content,
              files: [...payload.files],
              allowedMentions: { repliedUser: false, parse: [] },
            }),
          },
          text: deliveredResponse.text,
          characterMessages: deliveredResponse.characterMessages, characterDelayMs: deliveredResponse.characterDelayMs, characterIsCurrent: deliveredResponse.characterIsCurrent,
          characterCanDeliver: deliveredResponse.characterCanDeliver,
          recordDelivery: (sent) => { deliveredResponse.characterDeliveryProof = [...(deliveredResponse.characterDeliveryProof ?? []), { messageId: sent.id, content: sent.content }]; },
          sources: deliveredResponse.sources,
          images: deliveredResponse.generatedImages,
          emptyFallbackContent,
          maxImageAggregateBytes: this.configuration.chatDelivery.maxGeneratedImageAggregateBytes,
        });
        textDelivered = true;
        const botId = this.clientUserId();
        if (deliveredResponse.outputOrigin !== "tool" && botId && profile.chat.channelMemoryModes[message.channelId] !== "disabled")
          this.conversation!.observe(message.guildId, message.channelId, {
            messageId: firstMessageId, timestampMs: Date.now(), authorId: botId, authorDisplayName: profile.displayName,
            content: deliveredText, imageCount: deliveredResponse.generatedImages.length,
            replyToMessageId: target.id, replyToAuthorId: target.author.id,
          });
        if (deliveredResponse.outputOrigin !== "tool" && this.profiles.find(message.guildId)?.features.reactionReplies &&
            this.messageReactionWatchStore && await this.turnSupport.isEligible(message, trigger)) {
          await this.messageReactionWatchStore.register(
            { guildId: message.guildId, channelId: message.channelId, messageId: firstMessageId },
            Date.now(),
          ).then(() => {
            this.logger.info({ guildId: message.guildId, channelId: message.channelId, messageId: firstMessageId }, "Reaction-reply watch registered");
          }, (error: unknown) => {
            this.logger.warn({ error, guildId: message.guildId, channelId: message.channelId }, "Failed to register a message-reaction watch");
          });
        }
        return deliveredText;
      });

      const outcome = participation.shadowMode
        ? "previewed"
        : response.ambientAction === "reply"
        ? textDelivered ? "replied" : "reply suppressed"
        : response.reactionEmoji
          ? "reacted only"
          : "ignored";
      this.logger.info({
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author.id,
        triggerMode: trigger,
        shadowMode: participation.shadowMode,
        textDelivered,
        ambientAction: response.ambientAction,
        reactionEmoji: response.reactionEmoji,
        historyReactionCount: response.historyReactions.length,
        imageCount: images.length,
        droppedImageCount: droppedUnsupported + droppedOverLimit,
      }, `Ambient chat: ${outcome}`);
    } catch (error) {
      if (error instanceof SocialOutputSuppressed) return BehaviorResult.Continue;
      // Unlike a direct mention, a failed ambient judgment call fails silent
      // (no error reply) — the user never asked to be addressed, so
      // surfacing an error here would be more surprising than just staying
      // quiet.
      this.logger.error(
        { error, guildId: message.guildId, channelId: message.channelId, messageId: message.id, userId: message.author.id },
        "Ambient chat request failed",
      );
    }
    return BehaviorResult.Continue;
  }
}
