import type { SlashCommandSubcommandBuilder } from "discord.js";

import {
  formatRoleGroupList,
  roleGroupDescriptions,
} from "../../../../../application/access/role-group-descriptions.js";
import type { CommandContext } from "../../../../../application/commands/command.js";
import type { GuildConfiguration } from "../../../../../config/guild-configuration.js";
import type { UpdateGuildConfigurationInput } from "../../../../../config/guild-configuration-provider.js";
import type { MutationSettingDefinition, SettingDeps, SettingHandlerResult } from "./setting-definition.js";
import { addRoleGroupChoices, validateRoleGroupUpdate } from "./settings-support.js";

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

function configureRoleMembershipOptions(
  b: SlashCommandSubcommandBuilder,
  roleActionDescription: string,
): SlashCommandSubcommandBuilder {
  return b
    .addStringOption((o) => addRoleGroupChoices(o.setName("group").setDescription("Access group.").setRequired(true)))
    .addRoleOption((o) => o.setName("role").setDescription(roleActionDescription).setRequired(true));
}

export const roleAddSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "role-add",
  description: "Adds a role to an access group.",
  configureOptions: (b) => configureRoleMembershipOptions(b, "Role to add."),
  handle: (context, _deps: SettingDeps, previousProfile, input) =>
    Promise.resolve(handleRoleMembership("add", context, previousProfile, input)),
  describe: describeRoleMembership,
};

export const roleRemoveSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "role-remove",
  description: "Removes a role from an access group.",
  configureOptions: (b) => configureRoleMembershipOptions(b, "Role to remove."),
  handle: (context, _deps: SettingDeps, previousProfile, input) =>
    Promise.resolve(handleRoleMembership("remove", context, previousProfile, input)),
  describe: describeRoleMembership,
};
