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
  // Discord permission bitflags (e.g. PermissionFlagsBits.ManageGuild) — a
  // plain bigint, not the discord.js PermissionResolvable type, so this
  // domain type carries no discord.js dependency. All must be granted (AND,
  // not OR) — see access-rules.ts's hasAllPermissions.
  requiredMemberPermissions: readonly bigint[];
  requiredBotPermissions: readonly bigint[];
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
