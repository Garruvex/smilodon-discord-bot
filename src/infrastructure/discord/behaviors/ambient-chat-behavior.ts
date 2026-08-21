import type { Message } from "discord.js";
import type { Logger } from "pino";

import { ChatAccessService } from "../../../application/access/chat-access-service.js";
import { BehaviorEvent, BehaviorResult, type BotBehavior } from "../../../application/behaviors/behavior.js";
import { chatMemoryLimits } from "../../../application/chat/chat-memory-policy.js";
import type { ChannelHistoryMessage, ReplyChainMessage } from "../../../application/chat/chat-provider.js";
import type { ChatConversationService } from "../../../application/chat/chat-conversation-service.js";
import type { PersonaSource } from "../../../application/chat/persona-source.js";
import type { ApplicationConfiguration } from "../../../config/configuration.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { containsBotName } from "../../../domain/chat/name-mention.js";
import { ChatTurnSupport } from "./chat-turn-support.js";

// Handles messages that merely name the bot (per its configured
// branding.displayName) without an explicit @mention. Unlike
// MentionChatBehavior, which always replies, here the model itself judges
// whether to reply, react with an emoji, both, or neither — see triggerMode
// "ambient" on ChatRequest and ChatConversationService's short-circuit for
// non-"reply" outcomes. Opt-in per guild via features.ambientReplies.
export class AmbientChatBehavior implements BotBehavior<Message> {
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
  ) {
    this.chatAccess = new ChatAccessService(configuration);
    this.turnSupport = new ChatTurnSupport(logger);
  }

  public matches(message: Message): Promise<boolean> {
    const botId = this.clientUserId();
    if (!botId || !message.inGuild() || message.author.bot) return Promise.resolve(false);
    // An explicit @mention is MentionChatBehavior's job, always answered in
    // full — never re-judged here.
    if (message.mentions.users.has(botId)) return Promise.resolve(false);
    const profile = this.profiles.find(message.guildId);
    if (!profile) return Promise.resolve(false);
    // `named` is computed before the feature/access/cooldown gates below so
    // those gates can log a debug reason only when the bot's name was
    // actually said — logging on every unrelated message would be too
    // noisy to be useful.
    const liveNickname = message.guild.members.me?.nickname ?? message.guild.members.me?.displayName;
    const named =
      containsBotName(message.content, profile.displayName) ||
      (liveNickname ? containsBotName(message.content, liveNickname) : false);
    if (!named) return Promise.resolve(false);
    const logContext = { guildId: message.guildId, channelId: message.channelId, messageId: message.id };
    if (!profile.features.chatbot || !profile.features.ambientReplies) {
      this.logger.debug(logContext, "Ambient chat: name mentioned but ambientReplies feature is disabled for this guild");
      return Promise.resolve(false);
    }
    if (!this.conversation) {
      this.logger.debug(logContext, "Ambient chat: name mentioned but no conversation service is configured");
      return Promise.resolve(false);
    }
    if (!this.chatAccess.canUseMentionChat(profile, message.member, message.author.id, message.channelId)) {
      this.logger.debug(logContext, "Ambient chat: name mentioned but access policy denied this user/channel");
      return Promise.resolve(false);
    }
    const cooldownUntil = this.cooldownUntilByChannel.get(message.channelId) ?? 0;
    if (Date.now() < cooldownUntil) {
      this.logger.debug(
        { ...logContext, cooldownRemainingMs: cooldownUntil - Date.now() },
        "Ambient chat: name mentioned but channel is on cooldown",
      );
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  }

  public async execute(message: Message): Promise<BehaviorResult> {
    if (!message.inGuild() || !this.conversation) return BehaviorResult.Continue;
    const profile = this.profiles.find(message.guildId);
    if (!profile) return BehaviorResult.Continue;
    this.cooldownUntilByChannel.set(
      message.channelId,
      Date.now() + profile.chat.ambientCooldownSeconds * 1_000,
    );

    const replyChainMessages = await this.turnSupport.resolveReplyChain(message);
    const replyChain: ReplyChainMessage[] = replyChainMessages.map((hop) => ({
      authorId: hop.author.id,
      authorDisplayName: hop.member?.displayName ?? hop.author.displayName,
      content: hop.content.slice(0, chatMemoryLimits.maxUserMessageChars),
      imageCount: [...hop.attachments.values()].filter((attachment) => attachment.contentType?.startsWith("image/")).length,
    }));
    const channelHistory: ChannelHistoryMessage[] = profile.features.channelHistory
      ? (await this.turnSupport.resolveChannelHistory(
          message,
          profile.chat.channelHistoryLimit,
          new Set(replyChainMessages.map((hop) => hop.id)),
        )).map((hop) => ({
          authorId: hop.author.id,
          authorDisplayName: hop.member?.displayName ?? hop.author.displayName,
          content: hop.content.slice(0, chatMemoryLimits.maxUserMessageChars),
          imageCount: [...hop.attachments.values()].filter((attachment) => attachment.contentType?.startsWith("image/")).length,
        }))
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
        id: user.id,
        displayName: message.mentions.members?.get(user.id)?.displayName ?? user.displayName,
        roleNames: message.mentions.members?.get(user.id)?.roles.cache
          .filter((role) => role.id !== message.guildId)
          .map((role) => role.name.slice(0, 50))
          .slice(0, 10) ?? [],
      }));

    try {
      const { images } = await this.turnSupport.loadImages(imageAttachments);
      const musicActor = this.turnSupport.resolveMusicActor(message, profile);
      const persona = await this.personaSource.resolve(profile);
      const response = await this.conversation.run({
        guildId: message.guildId,
        channelId: message.channelId,
        personality: persona.personality,
        examplePool: persona.examplePool,
        loreChunks: persona.loreChunks,
        personaDrift: persona.personaDrift,
        personaDriftEnabled: profile.chat.personaDriftEnabled,
        currentUser: {
          id: message.author.id,
          displayName: message.member?.displayName ?? message.author.username,
          roleNames: message.member?.roles.cache
            .filter((role) => role.id !== message.guildId)
            .map((role) => role.name.slice(0, 50))
            .slice(0, 10) ?? [],
        },
        mentionedUsers,
        message: message.content,
        replyChain,
        channelHistory,
        images,
        webSearchMode: profile.chat.webSearchMode,
        imageGenerationEnabled: profile.chat.imageGenerationEnabled,
        includeSources: profile.chat.includeSources,
        triggerMode: "ambient",
        toolsEnabled: profile.chat.toolCallingEnabled,
        disabledToolNames: new Set(profile.chat.disabledTools),
        channelMemoryModes: profile.chat.channelMemoryModes,
        isOwner: this.configuration.ownerUserIds.has(message.author.id),
        channelIsNsfw: "nsfw" in message.channel ? Boolean(message.channel.nsfw) : false,
        musicActor: musicActor?.actor ?? null,
        musicVolumeMaximum: musicActor?.volumeMaximum,
        musicControllerRoleIds: musicActor?.musicControllerRoleIds,
        musicBotAdministratorRoleIds: musicActor?.botAdministratorRoleIds,
      }, async (deliveredResponse) => {
        const formatted = this.turnSupport.formatResponse(deliveredResponse.text, deliveredResponse.sources);
        const content = formatted.content || "I ran out of words. Very premium of me.";
        await message.reply({
          content,
          allowedMentions: { repliedUser: false, parse: [] },
        });
        return content;
      });

      if (response.reactionEmoji) {
        await message.react(response.reactionEmoji).catch((error: unknown) => {
          this.logger.warn(
            { error, guildId: message.guildId, channelId: message.channelId, messageId: message.id, emoji: response.reactionEmoji },
            "Ambient chat: failed to react with the model-chosen emoji",
          );
        });
      }
      const outcome = response.ambientAction === "reply"
        ? "replied"
        : response.reactionEmoji
          ? "reacted only"
          : "ignored";
      this.logger.info({
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author.id,
        ambientAction: response.ambientAction,
        reactionEmoji: response.reactionEmoji,
        imageCount: images.length,
        droppedImageCount: droppedUnsupported + droppedOverLimit,
      }, `Ambient chat: ${outcome}`);
    } catch (error) {
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
