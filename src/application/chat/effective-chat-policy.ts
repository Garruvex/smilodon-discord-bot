import type { GuildConfiguration } from "../../config/guild-configuration.js";
import { characterSettings } from "./character-settings.js";
import { resolveParticipation } from "./participation-policy.js";
import { resolveChannelMemoryMode } from "../memory/memory-channel-policy.js";
import { resolveConversationTurnPlan, type ConversationTurnPlan } from "./conversation-turn-plan.js";
import { admitChat, chatInteractions, isAddressedInteraction, isOptionalInteraction, type AdmissionReason, type ChatInteraction } from "./chat-policy.js";

export type PolicyReason = AdmissionReason | "reply_unavailable" | "reply_unknown" | "bot_cannot_read" |
  "decision_unavailable" | "decision_unknown" | "context_disabled" | "legacy_retrieval";
export interface EffectiveChatPolicy {
  turnPlan: ConversationTurnPlan;
  commonReasons: PolicyReason[];
  modes: { mode: ChatInteraction; reasons: PolicyReason[]; shadow: boolean }[];
  guarded: boolean;
  historyReasons: PolicyReason[];
  memoryMode: ReturnType<typeof resolveChannelMemoryMode>;
  participation: ReturnType<typeof resolveParticipation>;
  context: ReturnType<typeof characterSettings>["context"];
  observationInherited: boolean;
  participationOverrides: string[];
  contextOverride: boolean;
  scan: boolean;
  daily: boolean;
  roleCounts: { chat: number; administrator: number; restricted: number };
}

// A configuration/readiness explanation, never an authorization decision.
// Admission reasons come from the same rules the runtime gate applies, for a
// typical non-owner member. Individual source access, games, routing,
// cooldowns and quotas remain live gates.
export function effectiveChatPolicy(profile: GuildConfiguration, channelId: string, readiness: {
  reply: boolean | null; decision: boolean | null; botRead: boolean;
}): EffectiveChatPolicy {
  const settings = characterSettings(profile);
  const participation = resolveParticipation(profile.chat.participation, channelId);
  const turnPlan = resolveConversationTurnPlan(profile, channelId);
  const unique = (reasons: readonly PolicyReason[]): PolicyReason[] => [...new Set(reasons)];
  const common = unique([
    ...(turnPlan.state === "blocked" ? [turnPlan.reason === "channel_context_disabled" ? "context_channel_disabled" as const :
      turnPlan.reason === "legacy_retrieval" ? "legacy_retrieval" as const : "context_disabled" as const] : []),
    ...(!profile.features.chatbot ? ["chat_disabled" as const] : []),
    ...(readiness.reply === false ? ["reply_unavailable" as const] : readiness.reply === null ? ["reply_unknown" as const] : []),
    ...(!readiness.botRead ? ["bot_cannot_read" as const] : []),
  ]);
  const decision: PolicyReason[] = readiness.decision === false ? ["decision_unavailable"] : readiness.decision === null ? ["decision_unknown"] : [];
  return {
    turnPlan,
    modes: chatInteractions.map((mode) => ({ mode,
      reasons: unique([...common, ...admitChat(profile, channelId, mode).reasons, ...(isOptionalInteraction(mode) ? decision : [])]),
      shadow: !isAddressedInteraction(mode) && participation.shadowMode })),
    commonReasons: common, guarded: true,
    historyReasons: unique([...common, ...admitChat(profile, channelId, "observation").reasons]),
    memoryMode: resolveChannelMemoryMode(profile.chat.channelMemoryModes, channelId), participation, context: settings.context,
    observationInherited: profile.chat.participation?.observationChannelIds === undefined,
    participationOverrides: Object.keys(profile.chat.participation?.channelOverrides[channelId] ?? {}).sort(),
    contextOverride: settings.channelOverrides[channelId]?.contextEnabled !== undefined,
    scan: profile.chat.contextScanChannelIds.includes(channelId), daily: profile.chat.contextDailyChannelIds.includes(channelId),
    roleCounts: { chat: profile.roles.chatbot.size, administrator: profile.roles.botAdministrator.size, restricted: profile.roles.restricted.size },
  };
}
