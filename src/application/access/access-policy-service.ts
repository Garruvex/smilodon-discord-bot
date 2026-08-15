import type {
  ChatInputCommandInteraction,
  MessageComponentInteraction,
} from "discord.js";

import type { ApplicationConfiguration } from "../../config/configuration.js";
import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../../config/guild-configuration.js";
import { CommandModule } from "../commands/command.js";
import { AccessDenialReason, type AccessDecision } from "../../domain/access/access-decision.js";
import {
  RoleMatchMode,
  type CommandAccessPolicy,
} from "../../domain/access/access-policy.js";

export class AccessPolicyService {
  public constructor(
    private readonly configuration: ApplicationConfiguration,
    private readonly guildConfigurationProvider: GuildConfigurationProvider,
  ) {}

  public evaluate(
    policy: CommandAccessPolicy,
    commandModule: CommandModule,
    interaction: ChatInputCommandInteraction | MessageComponentInteraction,
  ): AccessDecision {
    if (!interaction.inCachedGuild()) {
      return { allowed: false, reason: AccessDenialReason.GuildRequired };
    }

    const guildConfiguration = this.guildConfigurationProvider.find(interaction.guildId);
    if (!guildConfiguration && !policy.allowUnconfiguredGuild) {
      return { allowed: false, reason: AccessDenialReason.GuildNotConfigured };
    }

    if (
      guildConfiguration &&
      !this.isFeatureEnabled(guildConfiguration, commandModule)
    ) {
      return { allowed: false, reason: AccessDenialReason.FeatureDisabled };
    }

    if (
      guildConfiguration?.channels.controlPanel === interaction.channelId
    ) {
      return { allowed: false, reason: AccessDenialReason.ChannelNotAllowed };
    }

    const member = interaction.member;
    const memberRoleIds = new Set(member.roles.cache.keys());
    const isOwner = this.configuration.ownerUserIds.has(interaction.user.id);

    if (
      guildConfiguration &&
      this.hasAnyRole(memberRoleIds, guildConfiguration.roles.restricted)
    ) {
      if (!(isOwner && policy.ownerBypass)) {
        return { allowed: false, reason: AccessDenialReason.RestrictedRole };
      }
    }

    if (policy.ownerOnly && !isOwner) {
      return { allowed: false, reason: AccessDenialReason.OwnerOnly };
    }

    if (isOwner && policy.ownerBypass) {
      return { allowed: true };
    }

    if (
      policy.allowedChannelIds.length > 0 &&
      !policy.allowedChannelIds.includes(interaction.channelId)
    ) {
      return { allowed: false, reason: AccessDenialReason.ChannelNotAllowed };
    }

    if (
      commandModule === CommandModule.Music &&
      guildConfiguration &&
      guildConfiguration.channels.musicCommands.size > 0 &&
      !guildConfiguration.channels.musicCommands.has(interaction.channelId)
    ) {
      return { allowed: false, reason: AccessDenialReason.ChannelNotAllowed };
    }

    if (
      !guildConfiguration &&
      policy.roles.match !== RoleMatchMode.None
    ) {
      return { allowed: false, reason: AccessDenialReason.MissingRequiredRole };
    }

    if (
      guildConfiguration &&
      !this.matchesRequiredRoleGroups(policy, memberRoleIds, guildConfiguration)
    ) {
      return { allowed: false, reason: AccessDenialReason.MissingRequiredRole };
    }

    if (!member.permissions.has(policy.requiredMemberPermissions)) {
      return { allowed: false, reason: AccessDenialReason.MissingMemberPermission };
    }

    const botMember = interaction.guild.members.me;
    if (
      !botMember ||
      !botMember.permissions.has(policy.requiredBotPermissions)
    ) {
      return { allowed: false, reason: AccessDenialReason.BotMissingPermission };
    }

    return { allowed: true };
  }

  private matchesRequiredRoleGroups(
    policy: CommandAccessPolicy,
    memberRoleIds: ReadonlySet<string>,
    guildConfiguration: GuildConfiguration,
  ): boolean {
    if (policy.roles.match === RoleMatchMode.None) {
      return true;
    }

    const matches = policy.roles.requiredGroups.map((groupName) =>
      this.hasAnyRole(
        memberRoleIds,
        this.resolveRoleGroup(guildConfiguration, groupName),
      ),
    );

    return policy.roles.match === RoleMatchMode.All
      ? matches.every(Boolean)
      : matches.some(Boolean);
  }

  private resolveRoleGroup(
    guildConfiguration: GuildConfiguration,
    groupName: "botAdministrator" | "musicController" | "chatbot",
  ): ReadonlySet<string> {
    if (groupName === "botAdministrator") {
      return guildConfiguration.roles.botAdministrator;
    }

    if (groupName === "chatbot") {
      return new Set([
        ...guildConfiguration.roles.chatbot,
        ...guildConfiguration.roles.botAdministrator,
      ]);
    }

    return new Set([
      ...guildConfiguration.roles.musicController,
      ...guildConfiguration.roles.botAdministrator,
    ]);
  }

  private hasAnyRole(
    memberRoleIds: ReadonlySet<string>,
    configuredRoleIds: ReadonlySet<string>,
  ): boolean {
    for (const roleId of configuredRoleIds) {
      if (memberRoleIds.has(roleId)) {
        return true;
      }
    }

    return false;
  }

  private isFeatureEnabled(
    guildConfiguration: GuildConfiguration,
    commandModule: CommandModule,
  ): boolean {
    switch (commandModule) {
      case CommandModule.Bootstrap:
        return true;
      case CommandModule.Common:
        return guildConfiguration.features.common;
      case CommandModule.Diagnostics:
        return guildConfiguration.features.diagnostics;
      case CommandModule.Music:
        return guildConfiguration.features.music;
    }
  }
}
