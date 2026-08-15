import type { PermissionResolvable } from "discord.js";
import type { RoleGroupName } from "../../config/guild-configuration.js";

export enum RoleMatchMode {
  None = "none",
  Any = "any",
  All = "all",
}

export interface RoleAccessPolicy {
  match: RoleMatchMode;
  requiredGroups: readonly RoleGroupName[];
}

export interface CommandAccessPolicy {
  allowUnconfiguredGuild: boolean;
  ownerOnly: boolean;
  ownerBypass: boolean;
  roles: RoleAccessPolicy;
  requiredMemberPermissions: readonly PermissionResolvable[];
  requiredBotPermissions: readonly PermissionResolvable[];
  allowedChannelIds: readonly string[];
}

export const publicAccessPolicy: CommandAccessPolicy = {
  allowUnconfiguredGuild: false,
  ownerOnly: false,
  ownerBypass: true,
  roles: {
    match: RoleMatchMode.None,
    requiredGroups: [],
  },
  requiredMemberPermissions: [],
  requiredBotPermissions: [],
  allowedChannelIds: [],
};
