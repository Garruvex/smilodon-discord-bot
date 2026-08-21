import type { GuildConfiguration } from "../../config/guild-configuration.js";
import { CommandModule } from "../commands/command.js";
import { AccessDenialReason } from "../../domain/access/access-decision.js";
import { RoleMatchMode, type CommandAccessPolicy } from "../../domain/access/access-policy.js";
import type { AccessRule } from "../../domain/access/access-rule.js";

// Each function below is one of the sequential checks AccessPolicyService.evaluate()
// used to run inline. Extracted so the exact same chain can run against either
// a live Discord interaction (AccessPolicyService) or a chat-tool invocation
// (music-tool-support.ts) via AccessPolicyEngine — see access-policy-engine.ts.

function hasAnyRole(memberRoleIds: ReadonlySet<string>, configuredRoleIds: ReadonlySet<string>): boolean {
  for (const roleId of configuredRoleIds) {
    if (memberRoleIds.has(roleId)) return true;
  }
  return false;
}

function resolveRoleGroup(
  guildConfiguration: GuildConfiguration,
  groupName: "botAdministrator" | "musicController" | "chatbot",
): ReadonlySet<string> {
  if (groupName === "botAdministrator") return guildConfiguration.roles.botAdministrator;
  if (groupName === "chatbot") {
    return new Set([...guildConfiguration.roles.chatbot, ...guildConfiguration.roles.botAdministrator]);
  }
  return new Set([...guildConfiguration.roles.musicController, ...guildConfiguration.roles.botAdministrator]);
}

function matchesRequiredRoleGroups(
  policy: CommandAccessPolicy,
  memberRoleIds: ReadonlySet<string>,
  guildConfiguration: GuildConfiguration,
): boolean {
  if (policy.roles.match === RoleMatchMode.None) return true;
  const matches = policy.roles.requiredGroups.map((groupName) =>
    hasAnyRole(memberRoleIds, resolveRoleGroup(guildConfiguration, groupName)));
  return policy.roles.match === RoleMatchMode.All ? matches.every(Boolean) : matches.some(Boolean);
}

function isFeatureEnabled(guildConfiguration: GuildConfiguration, commandModule: CommandModule): boolean {
  switch (commandModule) {
    case CommandModule.Bootstrap: return true;
    case CommandModule.Common: return guildConfiguration.features.common;
    case CommandModule.Diagnostics: return guildConfiguration.features.diagnostics;
    case CommandModule.Music: return guildConfiguration.features.music;
    case CommandModule.Birthdays: return guildConfiguration.features.birthdays;
    case CommandModule.Nsfw: return guildConfiguration.features.nsfw;
  }
}

export const guildConfiguredRule: AccessRule = (_subject, policy, _module, guildConfiguration) => {
  if (!guildConfiguration && !policy.allowUnconfiguredGuild) {
    return { allowed: false, reason: AccessDenialReason.GuildNotConfigured };
  }
  return null;
};

export const featureEnabledRule: AccessRule = (_subject, _policy, commandModule, guildConfiguration) => {
  if (guildConfiguration && !isFeatureEnabled(guildConfiguration, commandModule)) {
    return { allowed: false, reason: AccessDenialReason.FeatureDisabled };
  }
  return null;
};

export const controlPanelChannelRule: AccessRule = (subject, _policy, _module, guildConfiguration) => {
  if (guildConfiguration?.channels.controlPanel === subject.channelId) {
    return { allowed: false, reason: AccessDenialReason.ChannelNotAllowed };
  }
  return null;
};

export const restrictedRoleRule: AccessRule = (subject, policy, _module, guildConfiguration) => {
  if (!guildConfiguration) return null;
  const memberRoleIds = new Set(subject.member.roles.cache.keys());
  if (hasAnyRole(memberRoleIds, guildConfiguration.roles.restricted) && !(subject.isOwner && policy.ownerBypass)) {
    return { allowed: false, reason: AccessDenialReason.RestrictedRole };
  }
  return null;
};

export const ownerOnlyRule: AccessRule = (subject, policy) => {
  if (policy.ownerOnly && !subject.isOwner) {
    return { allowed: false, reason: AccessDenialReason.OwnerOnly };
  }
  return null;
};

export const allowedChannelRule: AccessRule = (subject, policy) => {
  if (subject.isOwner && policy.ownerBypass) return null;
  if (policy.allowedChannelIds.length > 0 && !policy.allowedChannelIds.includes(subject.channelId)) {
    return { allowed: false, reason: AccessDenialReason.ChannelNotAllowed };
  }
  return null;
};

export const musicChannelRule: AccessRule = (subject, policy, commandModule, guildConfiguration) => {
  if (subject.isOwner && policy.ownerBypass) return null;
  if (
    commandModule === CommandModule.Music &&
    guildConfiguration &&
    guildConfiguration.channels.musicCommands.size > 0 &&
    !guildConfiguration.channels.musicCommands.has(subject.channelId)
  ) {
    return { allowed: false, reason: AccessDenialReason.ChannelNotAllowed };
  }
  return null;
};

export const requiredRoleGroupRule: AccessRule = (subject, policy, _module, guildConfiguration) => {
  if (subject.isOwner && policy.ownerBypass) return null;
  const memberRoleIds = new Set(subject.member.roles.cache.keys());
  if (!guildConfiguration && policy.roles.match !== RoleMatchMode.None) {
    return { allowed: false, reason: AccessDenialReason.MissingRequiredRole };
  }
  if (guildConfiguration && !matchesRequiredRoleGroups(policy, memberRoleIds, guildConfiguration)) {
    return { allowed: false, reason: AccessDenialReason.MissingRequiredRole };
  }
  return null;
};

export const memberPermissionRule: AccessRule = (subject, policy) => {
  if (subject.isOwner && policy.ownerBypass) return null;
  if (!subject.member.permissions.has(policy.requiredMemberPermissions)) {
    return { allowed: false, reason: AccessDenialReason.MissingMemberPermission };
  }
  return null;
};

// Bot-permission checks always apply, even for an owner bypass: bypassing
// them would let a command report "allowed" while the bot itself can't
// execute it in Discord.
export const botPermissionRule: AccessRule = (subject, policy) => {
  if (!subject.botMember || !subject.botMember.permissions.has(policy.requiredBotPermissions)) {
    return { allowed: false, reason: AccessDenialReason.BotMissingPermission };
  }
  return null;
};

export const defaultAccessRules: readonly AccessRule[] = [
  guildConfiguredRule,
  featureEnabledRule,
  controlPanelChannelRule,
  restrictedRoleRule,
  ownerOnlyRule,
  allowedChannelRule,
  musicChannelRule,
  requiredRoleGroupRule,
  memberPermissionRule,
  botPermissionRule,
];
