import {
  formatRoleGroupList,
  roleGroupDescriptions,
} from "../../../../../application/access/role-group-descriptions.js";
import type { CommandContext } from "../../../../../application/commands/command.js";
import type { CommandOptionMetadata } from "../../../../../application/commands/command-metadata.js";
import type { GuildConfiguration } from "../../../../../config/guild-configuration.js";
import type { UpdateGuildConfigurationInput } from "../../../../../config/guild-configuration-provider.js";
import type { MutationSettingDefinition, SettingDeps, SettingHandlerResult } from "./setting-definition.js";
import { roleGroupChoices, validateRoleGroupUpdate } from "./settings-support.js";

type RoleGroup = "botAdministrator" | "musicController" | "restricted" | "chatbot";

function handleRoleMembership(
  action: "add" | "remove",
  context: CommandContext,
  previousProfile: GuildConfiguration,
  input: UpdateGuildConfigurationInput,
): SettingHandlerResult {
  const group = context.interaction.options.getString("group", true) as RoleGroup;
  const role = context.interaction.options.getRole("role", true);
  const roleIds = new Set(previousProfile.roles[group]);
  if (action === "add") roleIds.add(role.id);
  else roleIds.delete(role.id);
  const validationError = validateRoleGroupUpdate(previousProfile, group, roleIds);
  if (validationError) return { ok: false, message: validationError };
  if (group === "botAdministrator") input.botAdministratorRoleIds = [...roleIds];
  if (group === "musicController") input.musicControllerRoleIds = [...roleIds];
  if (group === "restricted") input.restrictedRoleIds = [...roleIds];
  if (group === "chatbot") input.chatbotRoleIds = [...roleIds];
  return { ok: true };
}

function describeRoleMembership(_previous: GuildConfiguration, updated: GuildConfiguration): string {
  return [
    "Access roles updated.",
    `Music controller: ${formatRoleGroupList(updated.roles.musicController)}`,
    roleGroupDescriptions.musicController,
  ].join("\n");
}

function configureRoleMembershipOptions(roleActionDescription: string): readonly CommandOptionMetadata[] {
  return [
    { type: "string", name: "group", description: "Access group.", required: true, choices: roleGroupChoices },
    { type: "role", name: "role", description: roleActionDescription, required: true },
  ];
}

export const roleAddSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "role-add",
  description: "Adds a role to an access group.",
  configureOptions: () => configureRoleMembershipOptions("Role to add."),
  handle: (context, _deps: SettingDeps, previousProfile, input) =>
    Promise.resolve(handleRoleMembership("add", context, previousProfile, input)),
  describe: describeRoleMembership,
};

export const roleRemoveSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "role-remove",
  description: "Removes a role from an access group.",
  configureOptions: () => configureRoleMembershipOptions("Role to remove."),
  handle: (context, _deps: SettingDeps, previousProfile, input) =>
    Promise.resolve(handleRoleMembership("remove", context, previousProfile, input)),
  describe: describeRoleMembership,
};
