import type { GuildConfiguration } from "../../config/guild-configuration.js";
import { characterSettings } from "./character-settings.js";
import { resolveParticipation } from "./participation-policy.js";
export function contextualFlow(profile: GuildConfiguration, channelId: string): boolean {
  const context = characterSettings(profile);
  return resolveParticipation(profile.chat.participation, channelId).flowVersion === "contextual_v1" && context.context.enabled &&
    context.context.retrievalMode === "eligible_count" && context.channelOverrides[channelId]?.contextEnabled !== false;
}
