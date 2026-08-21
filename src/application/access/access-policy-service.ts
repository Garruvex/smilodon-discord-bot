import type {
  ChatInputCommandInteraction,
  MessageComponentInteraction,
} from "discord.js";

import type { ApplicationConfiguration } from "../../config/configuration.js";
import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type { CommandModule } from "../commands/command.js";
import { AccessDenialReason, type AccessDecision } from "../../domain/access/access-decision.js";
import type { AccessSubject } from "../../domain/access/access-rule.js";
import type { CommandAccessPolicy } from "../../domain/access/access-policy.js";
import { AccessPolicyEngine } from "./access-policy-engine.js";

export class AccessPolicyService {
  public constructor(
    private readonly configuration: ApplicationConfiguration,
    private readonly guildConfigurationProvider: GuildConfigurationProvider,
    private readonly engine: AccessPolicyEngine = new AccessPolicyEngine(),
  ) {}

  public evaluate(
    policy: CommandAccessPolicy,
    commandModule: CommandModule,
    interaction: ChatInputCommandInteraction | MessageComponentInteraction,
  ): AccessDecision {
    // Interaction validity (is there even a cached guild/member to build a
    // subject from) is specific to a live Discord interaction, so it stays
    // here rather than in the shared rule chain — a chat-tool invocation
    // always has a resolved member by construction (see music-tool-support.ts).
    if (!interaction.inCachedGuild()) {
      return { allowed: false, reason: AccessDenialReason.GuildRequired };
    }

    const guildConfiguration = this.guildConfigurationProvider.find(interaction.guildId);
    const botMember = interaction.guild.members.me;
    const subject: AccessSubject = {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      roleIds: [...interaction.member.roles.cache.keys()],
      memberPermissions: interaction.member.permissions.bitfield,
      botPermissions: botMember?.permissions.bitfield ?? null,
      isOwner: this.configuration.ownerUserIds.has(interaction.user.id),
    };

    return this.engine.evaluate(subject, policy, commandModule, guildConfiguration);
  }
}
