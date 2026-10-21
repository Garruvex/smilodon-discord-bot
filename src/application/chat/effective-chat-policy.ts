import type { GuildConfiguration } from "../../config/guild-configuration.js";
import { characterSettings } from "./character-settings.js";
import { passiveChannelAllowed, resolveParticipation } from "./participation-policy.js";
import { resolveChannelMemoryMode } from "../memory/memory-channel-policy.js";
import { resolveConversationTurnPlan, type ConversationTurnPlan } from "./conversation-turn-plan.js";

export type PolicyReason = "chat_disabled" | "reply_unavailable" | "reply_unknown" | "bot_cannot_read" | "channel_not_selected" |
  "feature_disabled" | "history_disabled" | "observation_not_selected" | "context_channel_disabled" | "memory_disabled" |
  "decision_unavailable" | "decision_unknown" | "spontaneous_not_selected" | "context_disabled" | "legacy_retrieval";
export type PolicyMode = "direct" | "reply" | "bare_ping" | "name_address" | "continuation" | "spontaneous" | "reaction";
export interface EffectiveChatPolicy {
  turnPlan: ConversationTurnPlan;
  commonReasons: PolicyReason[];
  modes: { mode: PolicyMode; reasons: PolicyReason[]; shadow: boolean }[];
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
// Individual source access, games, routing, cooldowns and quotas remain live gates.
export function effectiveChatPolicy(profile: GuildConfiguration, channelId: string, readiness: {
  reply: boolean | null; decision: boolean | null; botRead: boolean;
}): EffectiveChatPolicy {
  const settings = characterSettings(profile); const context = settings.context;
  const participation = resolveParticipation(profile.chat.participation, channelId);
  const memoryMode = resolveChannelMemoryMode(profile.chat.channelMemoryModes, channelId);
  const guarded = context.enabled && context.retrievalMode === "eligible_count";
  const turnPlan = resolveConversationTurnPlan(profile, channelId);
  const directSelected = profile.channels.chatbot.size === 0 || profile.channels.chatbot.has(channelId);
  const common: PolicyReason[] = [
    ...(turnPlan.state === "blocked" ? [turnPlan.reason === "channel_context_disabled" ? "context_channel_disabled" as const :
      turnPlan.reason === "legacy_retrieval" ? "legacy_retrieval" as const : "context_disabled" as const] : []),
    ...(!profile.features.chatbot ? ["chat_disabled" as const] : []),
    ...(readiness.reply === false ? ["reply_unavailable" as const] : readiness.reply === null ? ["reply_unknown" as const] : []),
    ...(guarded && !readiness.botRead ? ["bot_cannot_read" as const] : []),
  ];
  const historyReasons: PolicyReason[] = [
    ...(!readiness.botRead ? ["bot_cannot_read" as const] : []),
    ...(!profile.features.channelHistory ? ["history_disabled" as const] : []),
    ...(!passiveChannelAllowed(profile, channelId) ? ["observation_not_selected" as const] : []),
    ...(settings.channelOverrides[channelId]?.contextEnabled === false ? ["context_channel_disabled" as const] : []),
    ...(memoryMode === "disabled" ? ["memory_disabled" as const] : []),
    ...(guarded && !directSelected ? ["channel_not_selected" as const] : []),
  ];
  const decision: PolicyReason[] = readiness.decision === false ? ["decision_unavailable"] : readiness.decision === null ? ["decision_unknown"] : [];
  const direct: PolicyReason[] = [...common, ...(!directSelected ? ["channel_not_selected" as const] : [])];
  const passive = [...common, ...historyReasons];
  const mode = (name: PolicyMode, reasons: PolicyReason[], shadow = false): EffectiveChatPolicy["modes"][number] => ({ mode: name, reasons: [...new Set(reasons)], shadow });
  return {
    turnPlan,
    modes: [mode("direct", direct), mode("reply", direct), mode("bare_ping", direct),
      mode("name_address", [...direct, ...(!profile.features.ambientReplies ? ["feature_disabled" as const] : [])], participation.shadowMode),
      mode("continuation", [...passive, ...decision, ...(!participation.continuationEnabled ? ["feature_disabled" as const] : [])], participation.shadowMode),
      mode("spontaneous", [...passive, ...decision,
        ...(!(profile.chat.participation?.channelOverrides[channelId]?.spontaneousEnabled ?? profile.chat.participation?.spontaneousEnabled ?? false) ? ["feature_disabled" as const] : []),
        ...(!participation.spontaneousChannelIds.includes(channelId) ? ["spontaneous_not_selected" as const] : [])], participation.shadowMode),
      mode("reaction", [...passive, ...(!profile.features.reactionReplies ? ["feature_disabled" as const] : [])], participation.shadowMode)],
    commonReasons: common, guarded, historyReasons: [...common, ...historyReasons], memoryMode, participation, context,
    observationInherited: profile.chat.participation?.observationChannelIds === undefined,
    participationOverrides: Object.keys(profile.chat.participation?.channelOverrides[channelId] ?? {}).sort(),
    contextOverride: settings.channelOverrides[channelId]?.contextEnabled !== undefined,
    scan: profile.chat.contextScanChannelIds.includes(channelId), daily: profile.chat.contextDailyChannelIds.includes(channelId),
    roleCounts: { chat: profile.roles.chatbot.size, administrator: profile.roles.botAdministrator.size, restricted: profile.roles.restricted.size },
  };
}
