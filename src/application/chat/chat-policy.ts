import type { GuildMember } from "discord.js";
import type { ApplicationConfiguration } from "../../config/configuration.js";
import type { GuildConfiguration } from "../../config/guild-configuration.js";
import { ChatAccessService } from "../access/chat-access-service.js";
import { characterSettings } from "./character-settings.js";
import { passiveChannelAllowed, resolveParticipation } from "./participation-policy.js";

// The one trigger vocabulary. Transport adapters label an event with one of
// these; every admission, explanation, prompt and diagnostic uses the label.
export const chatInteractions = ["direct_mention", "explicit_reply", "bare_ping", "name_address", "implicit_followup", "group_conversation", "reaction"] as const;
export type ChatInteraction = typeof chatInteractions[number];
// Reading or reacting to a source without starting a turn. Not a trigger.
export type ChatSourceUse = "observation" | "background_observation" | "history_reaction";
export type ChatPurpose = ChatInteraction | ChatSourceUse;

export const isAddressedInteraction = (interaction: ChatInteraction): boolean =>
  interaction === "direct_mention" || interaction === "explicit_reply" || interaction === "bare_ping";
// Explicit requests carry an application-owned answer obligation.
export const isExplicitInteraction = (interaction: ChatInteraction): boolean => isAddressedInteraction(interaction) || interaction === "name_address";
export const isOptionalInteraction = (interaction: ChatInteraction): interaction is "implicit_followup" | "group_conversation" =>
  interaction === "implicit_followup" || interaction === "group_conversation";

export type PassiveScopeReason = "observation_not_selected" | "history_disabled" | "memory_disabled" | "context_channel_disabled";
export type ActorReason = "context_opt_out" | "member_unavailable" | "restricted_role" | "channel_denied" | "missing_chat_role";
export type AdmissionReason = "chat_disabled" | PassiveScopeReason | ActorReason | "ambient_disabled" | "continuation_disabled" |
  "spontaneous_disabled" | "spontaneous_not_selected" | "reaction_disabled" | "unknown_bot_output" | "history_reactions_disabled" | "background_scope_denied";
export type Admission = { admitted: true; reasons: readonly [] } | { admitted: false; reason: AdmissionReason; reasons: readonly AdmissionReason[] };

// The event's author, resolved against guild roles by ChatPolicy.admit.
export interface PolicyActor { userId: string; bot: boolean; member: GuildMember | null }

// Configuration-only conditions for reading a channel's conversation.
export function passiveScopeReasons(profile: GuildConfiguration, channelId: string, observation = true): PassiveScopeReason[] {
  return [
    ...(observation && !passiveChannelAllowed(profile, channelId) ? ["observation_not_selected" as const] : []),
    ...(!profile.features.channelHistory ? ["history_disabled" as const] : []),
    ...(profile.chat.channelMemoryModes[channelId] === "disabled" ? ["memory_disabled" as const] : []),
    ...(characterSettings(profile).channelOverrides[channelId]?.contextEnabled === false ? ["context_channel_disabled" as const] : []),
  ];
}

// Admission rules. All reasons are collected so the runtime gate and the
// settings explanation cannot drift apart. Without an actor this evaluates
// configuration alone, as a typical non-owner member would see it. Source
// origin, game ownership, forgetting and quotas are live checks elsewhere.
export function admitChat(profile: GuildConfiguration, channelId: string, purpose: ChatPurpose, actor?: ResolvedActor): Admission {
  const reasons: AdmissionReason[] = [];
  if (!profile.features.chatbot) reasons.push("chat_disabled");
  if (purpose === "background_observation") {
    if (!canReadBackground(profile, channelId)) reasons.push("background_scope_denied");
    if (actor && !actor.bot && !actor.collect) reasons.push("context_opt_out");
    return result(reasons);
  }
  const participation = resolveParticipation(profile.chat.participation, channelId);
  // Explicit requests are answered where they were made; everything else
  // reads conversation the bot was not asked into and needs passive scope.
  const passive = !(isInteraction(purpose) && isExplicitInteraction(purpose));
  if (passive) reasons.push(...passiveScopeReasons(profile, channelId));
  if (purpose === "name_address" && !profile.features.ambientReplies) reasons.push("ambient_disabled");
  if (purpose === "implicit_followup" && !participation.continuationEnabled) reasons.push("continuation_disabled");
  if (purpose === "group_conversation") {
    const override = profile.chat.participation?.channelOverrides[channelId];
    if (!(override?.spontaneousEnabled ?? profile.chat.participation?.spontaneousEnabled ?? false)) reasons.push("spontaneous_disabled");
    if (!participation.spontaneousChannelIds.includes(channelId)) reasons.push("spontaneous_not_selected");
  }
  if (purpose === "reaction" && !profile.features.reactionReplies) reasons.push("reaction_disabled");
  if (purpose === "reaction" && actor && !actor.bot) reasons.push("unknown_bot_output");
  if (purpose === "history_reaction" && (!profile.features.historyReactions || participation.reactionsEnabled === false)) reasons.push("history_reactions_disabled");
  const channelSelected = profile.channels.chatbot.size === 0 || profile.channels.chatbot.has(channelId);
  // Bot-authored sources are reaction targets or verified chat output: their
  // author grants nothing, and explicit routing keeps the direct channel scope.
  if (!actor) {
    if (!channelSelected) reasons.push("channel_denied");
  } else if (actor.bot) {
    if (!passive && !channelSelected) reasons.push("channel_denied");
  } else reasons.push(...actor.reasons);
  return result(reasons);
}

// Actor facts resolved against guild roles before the rules run.
export type ResolvedActor = { bot: true } | { bot: false; collect: boolean; reasons: readonly ActorReason[] };

// The runtime gate: resolves the event author, then applies admitChat.
export class ChatPolicy {
  private readonly access: ChatAccessService;
  public constructor(configuration: ApplicationConfiguration) { this.access = new ChatAccessService(configuration); }

  public admit(profile: GuildConfiguration, channelId: string, purpose: ChatPurpose, actor?: PolicyActor): Admission {
    return admitChat(profile, channelId, purpose, actor && (actor.bot ? { bot: true } :
      { bot: false, collect: this.canCollect(profile, actor), reasons: this.actorReasons(profile, channelId, actor) }));
  }

  // A human who may start a turn here. Used for reaction initiators too.
  public actorReasons(profile: GuildConfiguration, channelId: string, actor: Omit<PolicyActor, "bot">): ActorReason[] {
    const access = this.access.mentionChatAccessReason(profile, actor.member, actor.userId, channelId);
    return [...(!this.canCollect(profile, actor) ? ["context_opt_out" as const] : []), ...(access === "allowed" ? [] : [access])];
  }

  // Collection opt-outs apply to every source and are never bypassed.
  public canCollect(profile: GuildConfiguration, actor: Pick<PolicyActor, "userId" | "member">): boolean {
    return this.access.canCollectContext(profile, actor.userId, actor.member);
  }

  public canReadBackground(profile: GuildConfiguration, channelId: string): boolean { return canReadBackground(profile, channelId); }
}

function canReadBackground(profile: GuildConfiguration, channelId: string): boolean {
  const mode = profile.chat.channelMemoryModes[channelId];
  return profile.features.chatbot && mode !== "disabled" && mode !== "session_only" &&
    (profile.chat.contextScanChannelIds.includes(channelId) || profile.chat.contextDailyChannelIds.includes(channelId));
}

function isInteraction(purpose: ChatPurpose): purpose is ChatInteraction {
  return (chatInteractions as readonly string[]).includes(purpose);
}

function result(reasons: AdmissionReason[]): Admission {
  const unique = [...new Set(reasons)];
  return unique.length ? { admitted: false, reason: unique[0]!, reasons: unique } : { admitted: true, reasons: [] };
}
