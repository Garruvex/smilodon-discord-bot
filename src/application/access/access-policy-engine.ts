import type { GuildConfiguration } from "../../config/guild-configuration.js";
import type { CommandModule } from "../commands/command.js";
import type { AccessDecision } from "../../domain/access/access-decision.js";
import type { CommandAccessPolicy } from "../../domain/access/access-policy.js";
import type { AccessRule, AccessSubject } from "../../domain/access/access-rule.js";
import { defaultAccessRules } from "./access-rules.js";

// Runs an ordered, fixed list of AccessRules against a subject built from
// either a live Discord interaction (AccessPolicyService) or a chat-tool
// invocation (music-tool-support.ts) — the single place both paths' access
// decisions are computed, so a channel restriction, owner bypass, or
// bot-permission check can't silently diverge between a slash command and
// its LLM tool binding.
export class AccessPolicyEngine {
  public constructor(private readonly rules: readonly AccessRule[] = defaultAccessRules) {}

  public evaluate(
    subject: AccessSubject,
    policy: CommandAccessPolicy,
    commandModule: CommandModule,
    guildConfiguration: GuildConfiguration | null,
  ): AccessDecision {
    for (const rule of this.rules) {
      const decision = rule(subject, policy, commandModule, guildConfiguration);
      if (decision) return decision;
    }
    return { allowed: true };
  }
}
