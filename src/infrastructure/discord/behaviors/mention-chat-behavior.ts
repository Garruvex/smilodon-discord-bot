import type { Message, User } from "discord.js";
import { chatDeliveryText } from "../../../application/i18n/chat-delivery.js";
import { randomBytes } from "node:crypto";
import { ChannelEditScheduler } from "../../../application/concurrency/channel-edit-scheduler.js";
import { ScheduledChatPreview } from "./scheduled-chat-preview.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import type { Logger } from "pino";
import { withDiscordCaller } from "../../../application/diagnostics/discord-diagnostics.js";
import { emitChatDiagnostic } from "../../../application/diagnostics/chat-diagnostics.js";
import { mentionInteraction } from "../../../application/chat/conversation-trigger.js";
import { conversationEffects } from "../../../application/chat/conversation-effects.js";
import { MentionChatAccess } from "./mention-chat-access.js";
import { buildChatTurnInput, type ChatTurnEnvironment } from "./chat-turn-request.js";
import { resolvesReplyToBot } from "./direct-reply-resolver.js";
import { SocialOutputSuppressed, type MessageOriginStore } from "../../../application/chat/message-origin-store.js";
import type { SocialChatEligibility } from "./social-chat-eligibility.js";
import { resolveParticipation, isLowSubstancePing } from "../../../application/chat/participation-policy.js";

import { ChatPolicy } from "../../../application/chat/chat-policy.js";
import { BehaviorEvent, BehaviorResult, type BotBehavior } from "../../../application/behaviors/behavior.js";
import { ChatProviderError } from "../../../application/chat/chat-provider.js";
import { ChatStateCommitError, type ChatConversationService } from "../../../application/chat/chat-conversation-service.js";
import { ChannelTypingManager } from "../../../application/chat/channel-typing-manager.js";
import type { PersonaSource } from "../../../application/chat/persona-source.js";
import type { ApplicationConfiguration } from "../../../config/configuration.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import type { MessageReactionWatchStore } from "../../../application/chat/message-reaction-watch.js";
import { ChatTurnSupport } from "./chat-turn-support.js";
import { isInGameChannel, type IsGameChannel } from "./game-channel-guard.js";

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
  private readonly chatAccess: MentionChatAccess;
  private readonly typing = new ChannelTypingManager();
  private readonly turnSupport: ChatTurnSupport;
  private readonly turnEnvironment: ChatTurnEnvironment;

  public constructor(
    private readonly clientUserId: () => string | null,
    private readonly configuration: ApplicationConfiguration,
    private readonly profiles: GuildConfigurationProvider,
    private readonly conversation: ChatConversationService | null,
    private readonly personaSource: PersonaSource,
    private readonly logger: Logger,
    // Optional: feature is opt-in per guild (features.reactionReplies) and
    // this can be entirely absent for a test double / a persistence backend
    // that hasn't wired one — registration below just no-ops without it.
    private readonly messageReactionWatchStore: MessageReactionWatchStore | null = null,
    // The narrator owns a D&D game's channels; chat stays out of them.
    private readonly isGameChannel: IsGameChannel | null = null,
    eligibility: SocialChatEligibility | null = null,
    private readonly origins: MessageOriginStore | null = null,
    private readonly edits: ChannelEditScheduler = new ChannelEditScheduler(),
  ) {
    this.chatAccess = new MentionChatAccess(new ChatPolicy(configuration), profiles, logger);
    this.turnSupport = new ChatTurnSupport(logger, eligibility, origins, (message) => {
      if (message.guildId) this.conversation?.excludeInteraction(message.guildId, message.channelId, message.id);
    });
    this.turnEnvironment = { profiles, ownerUserIds: configuration.ownerUserIds, support: this.turnSupport };
  }

  public async matches(message: Message): Promise<boolean> {
    const botId = this.clientUserId();
    if (!botId || !message.inGuild() || message.author.bot) return false;
    if (message.mentions.users.has(botId)) return true;
    if (!message.reference?.messageId || message.reference.channelId && message.reference.channelId !== message.channelId) return false;
    const allowFetch = async (): Promise<boolean> => !await isInGameChannel(message, this.isGameChannel) && (await this.chatAccess.resolve(message, "explicit_reply")).admission.admitted;
    const resolved = await resolvesReplyToBot(message, botId, this.origins, 4000, allowFetch);
    if (!resolved) emitChatDiagnostic(this.logger, { event: "chat.route.skipped", behaviorId: this.id, reason: "unresolved_reply_origin" });
    return resolved;
  }

  public async execute(message: Message): Promise<BehaviorResult> {
    if (!message.inGuild()) {
      emitChatDiagnostic(this.logger, { event: "chat.route.skipped", behaviorId: this.id, reason: "not_guild" });
      return BehaviorResult.Continue;
    }
    let profile = this.profiles.find(message.guildId);
    if (!profile?.features.chatbot) {
      emitChatDiagnostic(this.logger, { event: "chat.route.skipped", behaviorId: this.id, reason: "chat_disabled" });
      return BehaviorResult.Continue;
    }
    if (this.processedMessageIds.has(message.id)) {
      emitChatDiagnostic(this.logger, { event: "chat.route.skipped", behaviorId: this.id, reason: "duplicate" });
      return BehaviorResult.StopPropagation;
    }
    this.rememberMessage(message.id);
    if (await isInGameChannel(message, this.isGameChannel)) {
      emitChatDiagnostic(this.logger, { event: "chat.route.skipped", behaviorId: this.id, reason: "game_channel" });
      return BehaviorResult.Continue;
    }

    const botUserId = this.clientUserId();
    const interaction = botUserId && message.mentions.users.has(botUserId) ? mentionInteraction(message.content, botUserId, message.attachments.size > 0) : "explicit_reply";
    const access = await this.chatAccess.resolve(message, interaction);
    if (!access.profile || access.reason === "chat_disabled") return BehaviorResult.StopPropagation;
    profile = access.profile;
    if (access.reason !== "allowed") {
      const unavailable = access.reason === "member_unavailable";
      emitChatDiagnostic(this.logger, { event: "chat.route.skipped", behaviorId: this.id,
        reason: unavailable ? "access_unavailable" : "access_denied", accessReason: access.reason,
        memberRefresh: unavailable ? "unavailable" : "current" });
      if (unavailable) {
        const note = { en: "I couldn't verify your current server membership. Please try again shortly.",
          "zh-TW": "暫時無法確認你目前的伺服器成員資料，請稍後再試。", ja: "現在のサーバーメンバー情報を確認できませんでした。少し待って再度お試しください。" };
        await this.sendNote(message.guildId, message.author, note[profile.language]);
      } else {
        await message.reply({ content: profile.chat.deniedMessage,
          components: profile.chat.deniedLinkUrl ? [createChatAccessDeniedLinkButton(profile.chat.deniedLinkUrl, profile.chat.deniedLinkLabel)] : [],
          flags: MessageFlags.SuppressEmbeds, allowedMentions: { repliedUser: false } });
      }
      return BehaviorResult.StopPropagation;
    }
    if (!this.conversation) {
      emitChatDiagnostic(this.logger, { event: "chat.route.skipped", behaviorId: this.id, reason: "provider_unconfigured" });
      await message.reply({ content: "The chat subscription has not been configured yet.", allowedMentions: { repliedUser: false } });
      return BehaviorResult.StopPropagation;
    }
    if (!await this.turnSupport.isEligible(message, interaction)) return BehaviorResult.StopPropagation;
    this.conversation.cancelOptionalOpportunity?.(message.guildId, message.channelId, "addressed_request");

    const botId = this.clientUserId();
    const prompt = botId
      ? message.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim()
      : message.content.trim();
    const lowSubstance = isLowSubstancePing(prompt, Boolean(message.reference?.messageId), message.attachments.size > 0);

    if (this.conversation.isBusy(message.guildId, message.author.id)) {
      await this.sendNote(
        message.guildId,
        message.author,
        "Still working on your previous message — I'll get to this one right after.",
      );
    }

    const stopTyping = this.typing.start(
      message.channelId,
      async () => { if (!lowSubstance && await this.turnSupport.isEligible(message, interaction)) await message.channel.sendTyping(); },
    );
    // A plain object (rather than bare `let` variables) so TypeScript doesn't
    // over-narrow these to `never` in the catch block below: they're only
    // reassigned inside the async callbacks passed to conversation.run().
    const sentMessages: { preview: Message | null; delivered: Message | null } = {
      preview: null,
      delivered: null,
    };
    const previewState: { current: ScheduledChatPreview | null; closed: boolean } = { current: null, closed: false };
    try {
      const startedAt = Date.now();
      this.logger.info({
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author.id,
        model: this.configuration.chat?.models[0],
        provider: this.configuration.chat?.provider,
        maxOutputTokens: this.configuration.chat?.maxOutputTokens,
        webSearchMode: profile.chat.webSearchMode,
      }, "Chat API request started");
      const persona = await this.personaSource.resolve(profile);
      const response = await this.conversation.run(buildChatTurnInput(this.turnEnvironment, profile, persona, {
        interaction, source: message, text: prompt, botUserId: this.clientUserId(),
        canExecute: this.turnSupport.createEligibilityCheck(message, interaction),
        afterDecision: async (result) => {
          const effects = conversationEffects(result); if (!effects) return;
          const reserve = (): ((success: boolean) => void) | null => this.conversation!.reserveReaction(message.guildId, message.channelId,
            resolveParticipation(this.profiles.find(message.guildId)?.chat.participation, message.channelId).limits);
          if (effects.reactionEmoji && this.profiles.find(message.guildId)?.features.historyReactions &&
              await this.turnSupport.isEligible(message, "history_reaction")) {
            const release = reserve();
            if (release) { try { await withDiscordCaller("chat_reaction", () => message.react(effects.reactionEmoji!)); release(true); } catch { release(false); } }
          }
          await this.turnSupport.applyHistoryReactions(message.channel, effects.historyReactions,
            { guildId: message.guildId, sourceMessageId: message.id }, reserve);
        },
      }), async (deliveredResponse) => {
        const emptyFallbackContent = deliveredResponse.generatedImages.length > 0
          ? "Here you go!"
          : "I ran out of words. Very premium of me.";
        const { deliveredText, firstMessageId } = await this.turnSupport.deliverChatResponse({
          contextProvenance: deliveredResponse.contextProvenance ?? null,
          ...(deliveredResponse.contextLease ? { contextLease: deliveredResponse.contextLease } : {}),
          sourceMessage: message, purpose: interaction, origin: deliveredResponse.outputOrigin ?? "chat",
          sender: {
            first: async (payload) => {
              sentMessages.delivered = previewState.current
                ? await previewState.current.finish(payload, async () => {
                    if (deliveredResponse.characterIsCurrent && !deliveredResponse.characterIsCurrent() ||
                      deliveredResponse.characterCanDeliver && !await deliveredResponse.characterCanDeliver() ||
                      deliveredResponse.contextLease && !await deliveredResponse.contextLease.validate()) throw new SocialOutputSuppressed();
                  })
                : await message.reply({
                    nonce: payload.nonce, enforceNonce: payload.enforceNonce,
                    content: payload.content,
                    files: [...payload.files],
                    allowedMentions: { repliedUser: false, parse: [] },
                  });
              return sentMessages.delivered;
            },
            rest: (payload) => message.channel.send({
              nonce: payload.nonce, enforceNonce: payload.enforceNonce,
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
          partialDeliveryNotice: chatDeliveryText[profile.language].partial,
          maxImageAggregateBytes: this.configuration.chatDelivery.maxGeneratedImageAggregateBytes,
        });
        if (deliveredResponse.outputOrigin !== "tool" && botId && profile.chat.channelMemoryModes[message.channelId] !== "disabled") this.conversation!.observe(message.guildId, message.channelId, {
          messageId: firstMessageId, timestampMs: Date.now(), authorId: botId, authorDisplayName: profile.displayName,
          content: deliveredText, imageCount: deliveredResponse.generatedImages.length,
          replyToMessageId: message.id, replyToAuthorId: message.author.id,
        });
        if (deliveredResponse.outputOrigin !== "tool" && this.profiles.find(message.guildId)?.features.reactionReplies &&
            this.messageReactionWatchStore && await this.turnSupport.isEligible(message, interaction)) {
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
      }, {
        onImagePreview: async (image) => {
          if (previewState.closed) return;
          previewState.current ??= new ScheduledChatPreview(message, this.edits, () => this.turnSupport.assertEligible(message, interaction), chatDeliveryText[profile.language].preview);
          await previewState.current.preview(image);
          sentMessages.preview = previewState.current.message;
        },
      });
      this.logger.info({
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author.id,
        model: this.configuration.chat?.models[0],
        durationMs: Date.now() - startedAt,
        generatedImageCount: response.generatedImages.length,
        webSearchUsed: response.webSearchUsed,
        sourceCount: response.sources.length,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        totalTokens: response.usage?.totalTokens,
        cachedInputTokens: response.usage?.cachedInputTokens,
        reasoningTokens: response.usage?.reasoningTokens,
        memoryActionCount: response.userMemoryActions.length,
        historyReactionCount: response.historyReactions.length,
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
        channelHistoryMessages: response.contextUsage?.channelHistoryMessages,
        channelHistoryChars: response.contextUsage?.channelHistoryChars,
        currentMessageChars: response.contextUsage?.currentMessageChars,
      }, "Chat API request completed");
    } catch (error) {
      if (error instanceof SocialOutputSuppressed) return BehaviorResult.StopPropagation;
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
      if (sentMessages.delivered) return BehaviorResult.StopPropagation;
      if (previewState.current?.message) {
        await previewState.current.finish({ content, files: [], nonce: randomBytes(12).toString("hex"), enforceNonce: true }).catch(() => undefined);
      } else {
        await message.reply({ content, allowedMentions: { repliedUser: false } });
      }
    } finally {
      previewState.closed = true;
      previewState.current?.close();
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
