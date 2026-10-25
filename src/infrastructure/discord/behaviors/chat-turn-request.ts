import type { Message } from "discord.js";
import type { ChatConversationInput } from "../../../application/chat/chat-conversation-service.js";
import { isAddressedInteraction, isExplicitInteraction, isOptionalInteraction, type ChatInteraction } from "../../../application/chat/chat-policy.js";
import type { ChatUser, ConversationEvent } from "../../../application/chat/chat-provider.js";
import { characterSettings } from "../../../application/chat/character-settings.js";
import { resolveParticipation } from "../../../application/chat/participation-policy.js";
import type { ResolvedPersona } from "../../../application/chat/persona-source.js";
import { resolveChannelMemoryMode } from "../../../application/memory/memory-channel-policy.js";
import type { ChatActivityLimits } from "../../../application/chat/chat-scheduler.js";
import type { GuildConfiguration } from "../../../config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import type { ChatTurnSupport } from "./chat-turn-support.js";

// What differs between Discord entry points. Everything else is derived from
// the interaction and the guild profile below, in one place.
export interface ChatTurnParts {
  interaction: ChatInteraction;
  // The Discord message the turn answers: the user's message, or the bot's
  // own message for a reaction turn.
  source: Message;
  text: string;
  botUserId: string | null;
  canExecute: () => Promise<boolean>;
  afterDecision: NonNullable<ChatConversationInput["afterDecision"]>;
  currentUser?: ChatUser;
  mentionedUsers?: ChatConversationInput["mentionedUsers"];
  currentEvent?: ConversationEvent;
  currentBurst?: ChatConversationInput["currentBurst"];
  candidateId?: string;
}
export interface ChatTurnEnvironment { profiles: GuildConfigurationProvider; ownerUserIds: ReadonlySet<string>; support: ChatTurnSupport }

export function buildChatTurnInput(environment: ChatTurnEnvironment, profile: GuildConfiguration, persona: ResolvedPersona, parts: ChatTurnParts): ChatConversationInput {
  const { profiles, ownerUserIds, support } = environment;
  const { source, interaction } = parts;
  const guildId = source.guildId!; const channelId = source.channelId;
  const participation = resolveParticipation(profile.chat.participation, channelId);
  const live = (): GuildConfiguration | undefined => profiles.find(guildId) ?? undefined;
  // Addressed requests always deliver; everything else honors preview mode.
  const previewable = !isAddressedInteraction(interaction);
  const shadow = previewable && participation.shadowMode;
  const human = interaction !== "reaction";
  const musicActor = human ? support.resolveMusicActor(source, profile) : null;
  const context = characterSettings(profile).context;
  // A follow-up counts against this author's exchange from the first availability check, not only at delivery.
  const withExchange = (limits: ChatActivityLimits): ChatActivityLimits => interaction === "implicit_followup" ? { ...limits, exchangeId: `simple:${source.author.id}` } : limits;
  return {
    guildId, channelId, sourceMessageId: source.id, interaction,
    ...(parts.candidateId ? { candidateId: parts.candidateId } : {}),
    botUserId: parts.botUserId,
    currentEvent: parts.currentEvent ?? support.toMessageEvent(source),
    ...(parts.currentBurst ? { currentBurst: parts.currentBurst } : {}),
    canExecute: parts.canExecute,
    afterDecision: parts.afterDecision,
    activityLimits: withExchange(participation.limits),
    resolveActivityLimits: () => withExchange(resolveParticipation(live()?.chat.participation, channelId).limits),
    resolveMemoryMode: () => resolveChannelMemoryMode(live()?.chat.channelMemoryModes ?? {}, channelId),
    guardedContextPort: support.createContextPort(source, !human),
    guardedContextPolicy: { count: context.maxMessages, budget: context.budget, ...(human ? {} : { minReactors: profile.chat.reactionReplyMinReactors }) },
    ...(previewable ? { shadowMode: shadow, shouldDeliver: () => !resolveParticipation(live()?.chat.participation, channelId).shadowMode } : {}),
    personality: persona.personality,
    ...(persona.configurationContext ? { configurationContext: persona.configurationContext } : {}),
    examplePool: persona.examplePool, loreChunks: persona.loreChunks, personaDrift: persona.personaDrift,
    personaDriftEnabled: profile.chat.personaDriftEnabled, personalitySourceHash: persona.personalitySourceHash,
    currentUser: parts.currentUser ?? support.toChatUser(source.author, source.member),
    mentionedUsers: parts.mentionedUsers ?? source.mentions.users.filter((user) => !user.bot && user.id !== source.author.id)
      .map((user) => support.toChatUser(user, source.mentions.members?.get(user.id) ?? null)),
    message: parts.text, replyChain: [], channelHistory: [], images: [],
    channelHistoryEnabled: profile.features.channelHistory,
    historyReactionsEnabled: profile.features.historyReactions && profile.features.channelHistory,
    imageInputEnabled: profile.chat.imageInputEnabled, maxImagesPerRequest: profile.chat.maxImagesPerRequest,
    webSearchMode: profile.chat.webSearchMode, includeSources: profile.chat.includeSources,
    imageGenerationEnabled: isExplicitInteraction(interaction) && !shadow && profile.chat.imageGenerationEnabled,
    allowSilentDirect: isExplicitInteraction(interaction) && participation.barePingMode === "personality",
    // Optional turns may look up server facts but never take actions.
    toolsEnabled: human && !shadow && profile.chat.toolCallingEnabled,
    ...(isOptionalInteraction(interaction) ? { allowedToolNames: new Set(["lookup_discord_server"]) } : {}),
    disabledToolNames: new Set(profile.chat.disabledTools),
    channelMemoryModes: profile.chat.channelMemoryModes,
    channelIsNsfw: "nsfw" in source.channel ? Boolean(source.channel.nsfw) : false,
    ...(human ? {
      isOwner: ownerUserIds.has(source.author.id),
      musicActor: musicActor?.actor ?? null,
      musicResolveAccessSubjectFields: musicActor?.resolveAccessSubjectFields,
      musicVolumeMaximum: musicActor?.volumeMaximum,
      musicControllerRoleIds: musicActor?.musicControllerRoleIds,
      musicBotAdministratorRoleIds: musicActor?.botAdministratorRoleIds,
    } : {}),
  };
}
