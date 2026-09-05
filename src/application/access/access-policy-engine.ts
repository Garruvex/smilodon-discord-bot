import type { GuildConfiguration } from "../../config/guild-configuration.js";
import { CommandModule } from "../commands/command.js";
import type { AccessDecision } from "../../domain/access/access-decision.js";
import type { CommandAccessPolicy } from "../../domain/access/access-policy.js";
import type { AccessRule, AccessSubject } from "../../domain/access/access-rule.js";
import { defaultAccessRules, hasMusicDjPrivilege } from "./access-rules.js";

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

    // DJ mode only ever relaxes the Music module's voice-channel requirement
    // (see PlaybackService.assertControllablePlayer) — computed here, once,
    // as the last step of the same evaluation that already checked the
    // subject's roles, so callers never re-derive it themselves.
    const bypassVoiceChannelCheck =
      commandModule === CommandModule.Music && guildConfiguration
        ? hasMusicDjPrivilege(new Set(subject.roleIds), guildConfiguration)
        : false;
    return { allowed: true, bypassVoiceChannelCheck };
  }
}
