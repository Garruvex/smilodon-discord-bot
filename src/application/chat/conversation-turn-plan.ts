import type { GuildConfiguration } from "../../config/guild-configuration.js";
import { characterSettings } from "./character-settings.js";
import { contextualTurnLimits } from "./turn-work-budget.js";

export type ConversationPlanFailure = "profile_unavailable" | "guard_unavailable";
// Every turn reads guarded text context and uses the contextual decision.
// Channel history scope and opt-outs are enforced by the source adapters.
export interface ConversationTurnPlan { context: "guarded_text"; deadlineMs: number; contextPolicy: { count: number; budget: number } }

export function resolveConversationTurnPlan(profile: GuildConfiguration, _channelId?: string): ConversationTurnPlan {
  const context = characterSettings(profile).context;
  return { context: "guarded_text", deadlineMs: contextualTurnLimits.totalMs, contextPolicy: { count: context.maxMessages, budget: context.budget } };
}
