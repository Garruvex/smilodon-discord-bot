import type { Message } from "discord.js";
import { chatDeliveryText } from "../../../application/i18n/chat-delivery.js";
import type { Logger } from "pino";
import { withDiscordCaller } from "../../../application/diagnostics/discord-diagnostics.js";
import { SocialOutputSuppressed, type MessageOriginStore } from "../../../application/chat/message-origin-store.js";
import type { SocialChatEligibility } from "./social-chat-eligibility.js";
import { resolveParticipation } from "../../../application/chat/participation-policy.js";
import { conversationEffects } from "../../../application/chat/conversation-effects.js";

import { BehaviorEvent, BehaviorResult, type BotBehavior } from "../../../application/behaviors/behavior.js";
import { ChatStateCommitError, type ChatConversationService } from "../../../application/chat/chat-conversation-service.js";
import type { PersonaSource } from "../../../application/chat/persona-source.js";
import type { ApplicationConfiguration } from "../../../config/configuration.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { addressesBotName } from "../../../domain/chat/name-mention.js";
import type { MessageReactionWatchStore } from "../../../application/chat/message-reaction-watch.js";
import { ChatTurnSupport } from "./chat-turn-support.js";
import type { IsGameChannel } from "./game-channel-guard.js";
import { buildChatTurnInput, type ChatTurnEnvironment } from "./chat-turn-request.js";

// Handles messages that merely name the bot (per its configured
// branding.displayName) without an explicit @mention. Unlike
// MentionChatBehavior, which always replies, here the model itself judges
// whether to reply, react with an emoji, both, or neither — see interaction
// "ambient" on ChatRequest and ChatConversationService's short-circuit for
// non-"reply" outcomes. Opt-in per guild via features.ambientReplies.
export class AmbientChatBehavior implements BotBehavior<BehaviorEvent.MessageCreated> {
  public readonly id = "ambient-chat";
  public readonly event = BehaviorEvent.MessageCreated;
  // Lower than MentionChatBehavior's 100, so an explicit @mention always
  // wins if a message somehow matched both (in practice it can't: matches()
  // below explicitly defers to an existing @mention).
  public readonly priority = 90;
  private readonly turnSupport: ChatTurnSupport;
  private readonly turnEnvironment: ChatTurnEnvironment;

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
    // Game ownership is enforced by the eligibility gate below.
    _isGameChannel: IsGameChannel | null = null,
    eligibility: SocialChatEligibility | null = null,
    origins: MessageOriginStore | null = null,
  ) {
    this.turnSupport = new ChatTurnSupport(logger, eligibility, origins, (message) => {
      if (message.guildId) this.conversation?.excludeInteraction(message.guildId, message.channelId, message.id);
    });
    this.turnEnvironment = { profiles, ownerUserIds: configuration.ownerUserIds, support: this.turnSupport };
  }

  public async matches(message: Message): Promise<boolean> {
    const botId = this.clientUserId();
    if (!botId || !message.inGuild() || message.author.bot) return false;
    // An explicit @mention is MentionChatBehavior's job, always answered in
    // full — never re-judged here.
    if (message.mentions.users.has(botId)) return false;
    const profile = this.profiles.find(message.guildId);
    if (!profile) return false;
    // Name matching runs first so the common gate records a denial reason
    // only when the bot's name was actually said.
    const liveNickname = message.guild.members.me?.nickname ?? message.guild.members.me?.displayName;
    const named =
      addressesBotName(message.content, profile.displayName) ||
      (liveNickname ? addressesBotName(message.content, liveNickname) : false);
    if (!named || !this.conversation) return false;
    // Feature, access, game-channel and origin rules all live in the gate.
    return this.turnSupport.isEligible(message, "name_address");
  }

  public async execute(message: Message, interaction: "name_address" | "implicit_followup" | "group_conversation" = "name_address", burst: readonly Message[] = [], candidateId?: string): Promise<BehaviorResult> {
    if (interaction === "name_address" && message.guildId) this.conversation?.cancelOptionalOpportunity?.(message.guildId, message.channelId, "addressed_request");
    if (!message.inGuild() || !this.conversation) return BehaviorResult.Continue;
    const profile = this.profiles.find(message.guildId);
    if (!profile) return BehaviorResult.Continue;
    if (!await this.turnSupport.isEligible(message, interaction)) return BehaviorResult.Continue;
    const participation = resolveParticipation(profile.chat.participation, message.channelId);
    let textDelivered = false;
    try {
      const persona = await this.personaSource.resolve(profile);
      const eligible = this.turnSupport.createEligibilityCheck(message, interaction);
      const currentBurst = this.turnSupport.toChannelHistoryMessages((await Promise.all(burst.map(async (item) =>
        await this.turnSupport.isEligible(item, interaction) ? item : null))).filter((item): item is Message => item !== null)).map((event) => ({ ...event, content: event.content.slice(0, 500) }));
      const response = await this.conversation.run(buildChatTurnInput(this.turnEnvironment, profile, persona, {
        interaction, source: message, text: message.content, botUserId: this.clientUserId(), canExecute: eligible, currentBurst,
        ...(candidateId ? { candidateId } : {}),
        afterDecision: async (result) => {
          const effects = conversationEffects(result); if (!effects) return;
          if (result.characterIsCurrent && !result.characterIsCurrent() || result.characterCanDeliver && !await result.characterCanDeliver()) return;
          const reactionTarget = effects.targetMessageId && effects.targetMessageId !== message.id
            ? await message.channel.messages.fetch(effects.targetMessageId).catch(() => null) : message;
          const reserve = (): ((success: boolean) => void) | null => this.conversation!.reserveReaction(message.guildId, message.channelId,
            resolveParticipation(this.profiles.find(message.guildId)?.chat.participation, message.channelId).limits);
          if (effects.reactionEmoji && reactionTarget && await this.turnSupport.isEligible(reactionTarget, "history_reaction")) {
            const release = reserve();
            if (release) { try { await withDiscordCaller("chat_reaction", () => reactionTarget.react(effects.reactionEmoji!)); release(true); } catch { release(false); } }
          }
          await this.turnSupport.applyHistoryReactions(message.channel, effects.historyReactions,
            { guildId: message.guildId, sourceMessageId: message.id }, reserve);
        },
      }), async (deliveredResponse) => {
        const target = deliveredResponse.replyTargetMessageId && deliveredResponse.replyTargetMessageId !== message.id
          ? await message.channel.messages.fetch(deliveredResponse.replyTargetMessageId).catch(() => null) : message;
        if (!target || !await this.turnSupport.isEligible(target, interaction)) throw new SocialOutputSuppressed();
        const emptyFallbackContent = deliveredResponse.generatedImages.length > 0
          ? "Here you go!"
          : "I ran out of words. Very premium of me.";
        const { deliveredText, firstMessageId } = await this.turnSupport.deliverChatResponse({
          contextProvenance: deliveredResponse.contextProvenance ?? null,
          ...(deliveredResponse.contextLease ? { contextLease: deliveredResponse.contextLease } : {}),
          sourceMessage: target, purpose: interaction, origin: deliveredResponse.outputOrigin ?? "chat",
          sender: {
            first: (payload) => interaction !== "name_address" && target.id === message.id ? message.channel.send({ nonce: payload.nonce, enforceNonce: payload.enforceNonce, content: payload.content, files: [...payload.files], allowedMentions: { parse: [] } }) : target.reply({
              nonce: payload.nonce, enforceNonce: payload.enforceNonce,
              content: payload.content,
              files: [...payload.files],
              allowedMentions: { repliedUser: false, parse: [] },
            }),
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
        textDelivered = true;
        const botId = this.clientUserId();
        if (deliveredResponse.outputOrigin !== "tool" && botId && profile.chat.channelMemoryModes[message.channelId] !== "disabled")
          this.conversation!.observe(message.guildId, message.channelId, {
            messageId: firstMessageId, timestampMs: Date.now(), authorId: botId, authorDisplayName: profile.displayName,
            content: deliveredText, imageCount: deliveredResponse.generatedImages.length,
            replyToMessageId: target.id, replyToAuthorId: target.author.id,
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
        interaction,
        shadowMode: participation.shadowMode,
        textDelivered,
        ambientAction: response.ambientAction,
        reactionEmoji: response.reactionEmoji,
        historyReactionCount: response.historyReactions.length,
      }, `Ambient chat: ${outcome}`);
    } catch (error) {
      if (error instanceof SocialOutputSuppressed) return BehaviorResult.Continue;
      if (textDelivered || error instanceof ChatStateCommitError) return interaction === "name_address" ? BehaviorResult.StopPropagation : BehaviorResult.Continue;
      this.logger.error(
        { error, guildId: message.guildId, channelId: message.channelId, messageId: message.id, userId: message.author.id },
        "Ambient chat request failed",
      );
      if (interaction === "name_address" && await this.turnSupport.isEligible(message, "name_address")) {
        await withDiscordCaller("chat_text", () => message.reply({ content: "I couldn't answer that request right now. Please try again shortly.", allowedMentions: { repliedUser: false, parse: [] } }));
      }
    }
    return interaction === "name_address" ? BehaviorResult.StopPropagation : BehaviorResult.Continue;
  }
}
