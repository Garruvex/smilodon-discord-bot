import type { Message, User } from "discord.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import type { Logger } from "pino";

import { ChatAccessService } from "../../../application/access/chat-access-service.js";
import { BehaviorEvent, BehaviorResult, type BotBehavior } from "../../../application/behaviors/behavior.js";
import { chatMemoryLimits } from "../../../application/chat/chat-memory-policy.js";
import { ChatProviderError, type ChannelHistoryMessage, type ReplyChainMessage } from "../../../application/chat/chat-provider.js";
import { ChatStateCommitError, type ChatConversationService } from "../../../application/chat/chat-conversation-service.js";
import { ChannelTypingManager } from "../../../application/chat/channel-typing-manager.js";
import type { PersonaSource } from "../../../application/chat/persona-source.js";
import type { ApplicationConfiguration } from "../../../config/configuration.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { ChatTurnSupport } from "./chat-turn-support.js";

function createChatAccessDeniedLinkButton(url: string, label: string | null): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel(label ?? url)
      .setStyle(ButtonStyle.Link)
      .setURL(url),
  );
}

export class MentionChatBehavior implements BotBehavior<BehaviorEvent.MessageCreated> {
  public readonly id = "mention-chat";
  public readonly event = BehaviorEvent.MessageCreated;
  public readonly priority = 100;
  private readonly processedMessageIds = new Set<string>();
  private readonly chatAccess: ChatAccessService;
  private readonly typing = new ChannelTypingManager();
  private readonly turnSupport: ChatTurnSupport;

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
    return Promise.resolve(Boolean(botId && message.inGuild() && !message.author.bot && message.mentions.users.has(botId)));
  }

  public async execute(message: Message): Promise<BehaviorResult> {
    if (!message.inGuild()) return BehaviorResult.Continue;
    const profile = this.profiles.find(message.guildId);
    if (!profile?.features.chatbot) return BehaviorResult.Continue;
    if (this.processedMessageIds.has(message.id)) return BehaviorResult.StopPropagation;
    this.rememberMessage(message.id);

    if (!this.chatAccess.canUseMentionChat(profile, message.member, message.author.id, message.channelId)) {
      await message.reply({
        content: profile.chat.deniedMessage,
        components: profile.chat.deniedLinkUrl
          ? [createChatAccessDeniedLinkButton(profile.chat.deniedLinkUrl, profile.chat.deniedLinkLabel)]
          : [],
        flags: MessageFlags.SuppressEmbeds,
        allowedMentions: { repliedUser: false },
      });
      return BehaviorResult.StopPropagation;
    }
    if (!this.conversation) {
      await message.reply({ content: "The chat subscription has not been configured yet.", allowedMentions: { repliedUser: false } });
      return BehaviorResult.StopPropagation;
    }

    const botId = this.clientUserId();
    const prompt = botId
      ? message.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim()
      : message.content.trim();
    // Oldest ancestor first, ending just before `message` itself.
    const { kept: replyChainMessages, overflow: replyChainOverflowMessages } = await this.turnSupport.resolveReplyChain(message);
    const replyChain: ReplyChainMessage[] = replyChainMessages.map((hop) => ({
      authorId: hop.author.id,
      authorDisplayName: hop.member?.displayName ?? hop.author.displayName,
      content: hop.content.slice(0, chatMemoryLimits.maxUserMessageChars),
      imageCount: [...hop.attachments.values()].filter((attachment) => attachment.contentType?.startsWith("image/")).length,
    }));
    // Older hops beyond replyChain's kept window — condensed into a recap
    // by ChatConversationService before this turn's reply is generated (see
    // ChatConversationInput.replyChainOverflow). No image handling here:
    // by the time content is old enough to be summarized away, its images
    // aren't worth the extra fetch/attach cost.
    const replyChainOverflow: ReplyChainMessage[] = replyChainOverflowMessages.map((hop) => ({
      authorId: hop.author.id,
      authorDisplayName: hop.member?.displayName ?? hop.author.displayName,
      content: hop.content.slice(0, chatMemoryLimits.maxUserMessageChars),
      imageCount: 0,
    }));
    const channelHistory: ChannelHistoryMessage[] = profile.features.channelHistory
      ? this.turnSupport.toChannelHistoryMessages(await this.turnSupport.resolveChannelHistory(
          message,
          profile.chat.channelHistoryLimit,
          new Set(replyChainMessages.map((hop) => hop.id)),
        ))
      : [];
    const { selected: imageAttachments, droppedUnsupported, droppedOverLimit } = profile.chat.imageInputEnabled
      ? this.turnSupport.selectImageAttachments(
          [...message.attachments.values()],
          // Nearest-to-current hop first, so recency wins once truncated to the limit.
          [...replyChainMessages].reverse().map((hop) => [...hop.attachments.values()]),
          profile.chat.maxImagesPerRequest,
        )
      : { selected: [], droppedUnsupported: 0, droppedOverLimit: 0 };
    // An empty tag is still a valid request when it's a reply — "@bot" on
    // its own replying to someone else's message means "look at this", with
    // the replied-to message standing in for the question (see the reply
    // chain instructions in buildChatInstructions). Only bail out empty-
    // handed when there's truly nothing to go on.
    if (!prompt && imageAttachments.length === 0 && replyChainMessages.length === 0) {
      await message.reply({ content: "Mention me with a question or supported image and I'll try to help.", allowedMentions: { repliedUser: false } });
      return BehaviorResult.StopPropagation;
    }

    if (this.conversation.isBusy(message.guildId, message.author.id)) {
      await this.sendNote(
        message.guildId,
        message.author,
        "Still working on your previous message — I'll get to this one right after.",
      );
    }

    const stopTyping = this.typing.start(
      message.channelId,
      () => message.channel.sendTyping(),
    );
    // A plain object (rather than bare `let` variables) so TypeScript doesn't
    // over-narrow these to `never` in the catch block below: they're only
    // reassigned inside the async callbacks passed to conversation.run().
    const sentMessages: { preview: Message | null; delivered: Message | null } = {
      preview: null,
      delivered: null,
    };
    try {
      const { images, droppedFailed } = await this.turnSupport.loadImages(imageAttachments);
      const droppedImageCount = droppedUnsupported + droppedOverLimit + droppedFailed;
      if (droppedImageCount > 0) {
        await this.sendNote(
          message.guildId,
          message.author,
          `${droppedImageCount} image${droppedImageCount > 1 ? "s" : ""} skipped — check the per-message image limit, or the file's size/format.`,
        );
      }
      const startedAt = Date.now();
      this.logger.info({
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author.id,
        model: this.configuration.chat?.models[0],
        provider: this.configuration.chat?.provider,
        maxOutputTokens: this.configuration.chat?.maxOutputTokens,
        imageCount: images.length,
        droppedImageCount,
        webSearchMode: profile.chat.webSearchMode,
      }, "Chat API request started");
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
        personalitySourceHash: persona.personalitySourceHash,
        currentUser: {
          id: message.author.id,
          displayName: message.member?.displayName ?? message.author.username,
          roleNames: message.member?.roles.cache
            .filter((role) => role.id !== message.guildId)
            .map((role) => role.name.slice(0, 50))
            .slice(0, 10) ?? [],
        },
        mentionedUsers,
        message: prompt,
        replyChain,
        replyChainOverflow,
        channelHistory,
        images,
        webSearchMode: profile.chat.webSearchMode,
        imageGenerationEnabled: profile.chat.imageGenerationEnabled,
        includeSources: profile.chat.includeSources,
        triggerMode: "direct",
        toolsEnabled: profile.chat.toolCallingEnabled,
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
        const emptyFallbackContent = deliveredResponse.generatedImages.length > 0
          ? "Here you go!"
          : "I ran out of words. Very premium of me.";
        const { deliveredText } = await this.turnSupport.deliverChatResponse({
          sender: {
            first: async (payload) => {
              sentMessages.delivered = sentMessages.preview
                ? await sentMessages.preview.edit({
                    content: payload.content,
                    files: [...payload.files],
                    attachments: [],
                    allowedMentions: { repliedUser: false, parse: [] },
                  })
                : await message.reply({
                    content: payload.content,
                    files: [...payload.files],
                    allowedMentions: { repliedUser: false, parse: [] },
                  });
              return sentMessages.delivered;
            },
            rest: (payload) => message.channel.send({
              content: payload.content,
              files: [...payload.files],
              allowedMentions: { repliedUser: false, parse: [] },
            }),
          },
          text: deliveredResponse.text,
          sources: deliveredResponse.sources,
          images: deliveredResponse.generatedImages,
          emptyFallbackContent,
          maxImageAggregateBytes: this.configuration.chatDelivery.maxGeneratedImageAggregateBytes,
        });
        return deliveredText;
      }, {
        onImagePreview: async (image) => {
          const payload = {
            content: "Generating your image…",
            files: [{ attachment: image.data, name: image.filename }],
            allowedMentions: { repliedUser: false, parse: [] as never[] },
          };
          if (sentMessages.preview) {
            await sentMessages.preview.edit({ ...payload, attachments: [] });
          } else {
            sentMessages.preview = await message.reply(payload);
          }
        },
      });
      this.logger.info({
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author.id,
        model: this.configuration.chat?.models[0],
        durationMs: Date.now() - startedAt,
        imageCount: images.length,
        droppedImageCount,
        generatedImageCount: response.generatedImages.length,
        webSearchUsed: response.webSearchUsed,
        sourceCount: response.sources.length,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        totalTokens: response.usage?.totalTokens,
        cachedInputTokens: response.usage?.cachedInputTokens,
        reasoningTokens: response.usage?.reasoningTokens,
        memoryActionCount: response.userMemoryActions.length,
        personalityChars: response.contextUsage?.personalityChars,
        userCustomizationChars: response.contextUsage?.userCustomizationChars,
        securityInstructionChars: response.contextUsage?.securityInstructionChars,
        memoryInstructionChars: response.contextUsage?.memoryInstructionChars,
        historyMessages: response.contextUsage?.historyMessages,
        historyChars: response.contextUsage?.historyChars,
        memoryRecordCount: response.contextUsage?.memoryRecords,
        memoryChars: response.contextUsage?.memoryChars,
        guildKnowledgeRecordCount: response.contextUsage?.guildKnowledgeRecords,
        guildKnowledgeChars: response.contextUsage?.guildKnowledgeChars,
        replyChainMessages: response.contextUsage?.replyChainMessages,
        replyChainChars: response.contextUsage?.replyChainChars,
        currentMessageChars: response.contextUsage?.currentMessageChars,
      }, "Chat API request completed");
    } catch (error) {
      this.logger.error({ error, guildId: message.guildId, channelId: message.channelId, messageId: message.id, userId: message.author.id }, "Mention chat request failed");
      if (error instanceof ChatStateCommitError) {
        // The reply was already delivered before the commit failed, so tell the
        // user their exchange won't be remembered instead of failing silently.
        await this.sendNote(
          message.guildId,
          message.author,
          "I couldn't save that exchange, so I won't remember it.",
        );
        return BehaviorResult.StopPropagation;
      }
      const content = error instanceof ChatProviderError && error.status === 429
        ? error.code === "insufficient_quota" || error.code === "credit_balance_exhausted"
          ? "The premium brain's API quota is empty. Please let a bot administrator know."
          : "The premium brain is receiving too many requests. Please try again shortly."
        : "The premium brain is temporarily buffering. Please try again later.";
      // If an image-generation preview was already posted, replace it with the
      // error instead of leaving "Generating your image…" stuck forever while
      // also posting a separate error reply.
      if (sentMessages.preview) {
        await sentMessages.preview.edit({ content, files: [], attachments: [] }).catch(() => undefined);
      } else {
        await message.reply({ content, allowedMentions: { repliedUser: false } });
      }
    } finally {
      stopTyping();
    }
    return BehaviorResult.StopPropagation;
  }

  // Regular channel messages (unlike slash-command/interaction responses)
  // have no ephemeral option in Discord's API, so system notes about the
  // request itself (dropped images, truncation, etc.) can't be made visible
  // only to the requester in-channel. DMing them is the only private
  // delivery option; gated by the user's own /memory notes preference, and
  // silently dropped (never leaked back into the channel) if the DM fails —
  // e.g. the user has DMs from server members turned off.
  private async sendNote(guildId: string, user: User, note: string): Promise<void> {
    if (!this.conversation) return;
    const enabled = await this.conversation.getDmNotesEnabled(guildId, user.id).catch(() => true);
    if (!enabled) return;
    await user.send(note).catch(() => undefined);
  }

  private rememberMessage(messageId: string): void {
    this.processedMessageIds.add(messageId);
    const timer = setTimeout(() => this.processedMessageIds.delete(messageId), 5 * 60 * 1_000);
    timer.unref();
  }

}
