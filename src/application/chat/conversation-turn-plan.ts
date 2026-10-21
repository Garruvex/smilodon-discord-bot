import type { GuildConfiguration } from "../../config/guild-configuration.js";
import { characterSettings } from "./character-settings.js";
import { resolveParticipation } from "./participation-policy.js";
import { contextualTurnLimits } from "./turn-work-budget.js";

export type ConversationPlanFailure = "profile_unavailable" | "context_disabled" | "legacy_retrieval" | "channel_context_disabled" | "guard_unavailable" | "guard_mismatch";
interface PlanBase { flow: "legacy" | "contextual_v1"; context: "legacy" | "guarded_text"; deadlineMs: number | null;
  contextPolicy: { count: number; budget: number } }
export type ConversationTurnPlan = PlanBase & ({ state: "ready"; decision: "legacy" | "contextual" } | { state: "blocked"; reason: ConversationPlanFailure });
export type ActiveConversationTurnPlan = Extract<ConversationTurnPlan, { state: "ready" }>;

export function resolveConversationTurnPlan(profile: GuildConfiguration, channelId: string): ConversationTurnPlan {
  const settings = characterSettings(profile); const context = settings.context;
  const flow = resolveParticipation(profile.chat.participation, channelId).flowVersion ?? "legacy";
  const guarded = context.enabled && context.retrievalMode === "eligible_count";
  const base: PlanBase = { flow, context: guarded ? "guarded_text" : "legacy", deadlineMs: guarded ? contextualTurnLimits.totalMs : null,
    contextPolicy: { count: context.maxMessages, budget: context.budget } };
  if (flow === "contextual_v1") {
    const reason = !context.enabled ? "context_disabled" : context.retrievalMode !== "eligible_count" ? "legacy_retrieval" :
      settings.channelOverrides[channelId]?.contextEnabled === false ? "channel_context_disabled" : null;
    if (reason) return { ...base, state: "blocked", reason };
  }
  return { ...base, state: "ready", decision: flow === "contextual_v1" ? "contextual" : "legacy" };
}
export function usesGuardedContext(profile: GuildConfiguration, channelId: string): boolean {
  return resolveConversationTurnPlan(profile, channelId).context === "guarded_text";
}
