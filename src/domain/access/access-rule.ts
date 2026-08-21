import type { GuildMember } from "discord.js";

import type { GuildConfiguration } from "../../config/guild-configuration.js";
import type { CommandModule } from "../../application/commands/command.js";
import type { AccessDecision } from "./access-decision.js";
import type { CommandAccessPolicy } from "./access-policy.js";

// Interaction-agnostic stand-in for whoever is invoking a command or tool —
// built either from a live Discord interaction (AccessPolicyService) or from
// a ChatToolContext's music actor (music-tool-support.ts), so the same rule
// chain (see access-rules.ts / AccessPolicyEngine) can evaluate both.
export interface AccessSubject {
  guildId: string;
  channelId: string;
  userId: string;
  member: GuildMember;
  botMember: GuildMember | null;
  isOwner: boolean;
}

// Returns a denial to short-circuit the chain, or null to mean "no opinion,
// continue to the next rule". AccessPolicyEngine treats reaching the end of
// the list with no denial as allowed.
export type AccessRule = (
  subject: AccessSubject,
  policy: CommandAccessPolicy,
  commandModule: CommandModule,
  guildConfiguration: GuildConfiguration | null,
) => AccessDecision | null;
