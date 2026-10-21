import type { GuildConfiguration } from "../../config/guild-configuration.js";
import { resolveConversationTurnPlan } from "./conversation-turn-plan.js";
export function contextualFlow(profile: GuildConfiguration, channelId: string): boolean {
  const plan = resolveConversationTurnPlan(profile, channelId);
  return plan.state === "ready" && plan.decision === "contextual";
}
