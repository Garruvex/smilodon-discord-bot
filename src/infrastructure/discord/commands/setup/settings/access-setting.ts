import {
  formatRoleGroupList,
  roleGroupDescriptions,
} from "../../../../../application/access/role-group-descriptions.js";
import type { GuildConfiguration } from "../../../../../config/guild-configuration.js";
import type { ReadOnlySettingDefinition } from "./setting-definition.js";

export function formatAccessSummary(profile: GuildConfiguration): string {
  return [
    "Configured access roles:",
    `Bot administrator: ${formatRoleGroupList(profile.roles.botAdministrator)}`,
    `Music controller: ${formatRoleGroupList(profile.roles.musicController)}`,
    `Restricted: ${formatRoleGroupList(profile.roles.restricted)}`,
    `Chatbot: ${formatRoleGroupList(profile.roles.chatbot)}`,
    "",
    "Role purposes:",
    `- Bot administrator: ${roleGroupDescriptions.botAdministrator}`,
    `- Music controller: ${roleGroupDescriptions.musicController}`,
    `- Restricted: ${roleGroupDescriptions.restricted}`,
    `- Chatbot: ${roleGroupDescriptions.chatbot}`,
  ].join("\n");
}

export const accessSetting: ReadOnlySettingDefinition = {
  kind: "readOnly",
  name: "access",
  description: "Shows configured access roles and what each group controls.",
  run: (_context, _deps, profile) => Promise.resolve(formatAccessSummary(profile)),
};
