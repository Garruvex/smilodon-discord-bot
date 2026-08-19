import { accessSetting } from "./access-setting.js";
import { ambientRepliesSetting } from "./ambient-replies-setting.js";
import { auditSetting } from "./audit-setting.js";
import { auditLogSetting } from "./audit-log-setting.js";
import { birthdaysSetting } from "./birthdays-setting.js";
import { channelHistorySetting } from "./channel-history-setting.js";
import { chatbotSetting } from "./chatbot-setting.js";
import { lifecycleSetting } from "./lifecycle-setting.js";
import { linkFixSetting } from "./link-fix-setting.js";
import { nsfwSetting } from "./nsfw-setting.js";
import { panelSetting } from "./panel-setting.js";
import { retainMemberDataSetting } from "./retain-member-data-setting.js";
import { roleAddSetting, roleRemoveSetting } from "./role-membership-setting.js";
import { rolesSetting } from "./roles-setting.js";
import type { SettingDefinition } from "./setting-definition.js";
import { volumeSetting } from "./volume-setting.js";

export type {
  FieldChange,
  MutationSettingDefinition,
  ReadOnlySettingDefinition,
  SettingDefinition,
  SettingDeps,
  SettingHandlerResult,
} from "./setting-definition.js";

export interface SettingGroup {
  name: string;
  description: string;
  settings: readonly SettingDefinition[];
}

// Adding a setting: write one file next to these exporting a
// SettingDefinition, then add it to the right group's `settings` list below.
// Removing one: delete the file, remove it from its group. Adding a whole
// new group: add one entry to this list — /settings <group> <setting> is
// built entirely from this structure (see SettingsCommand.buildDefinition).
export const settingGroups: readonly SettingGroup[] = [
  {
    name: "access",
    description: "Roles, permissions, and audit logging.",
    settings: [accessSetting, rolesSetting, roleAddSetting, roleRemoveSetting, auditLogSetting, auditSetting],
  },
  {
    name: "music",
    description: "Music panel and playback behavior.",
    settings: [panelSetting, volumeSetting, lifecycleSetting],
  },
  {
    name: "chat",
    description: "AI chat behavior.",
    settings: [chatbotSetting, ambientRepliesSetting, channelHistorySetting],
  },
  {
    name: "community",
    description: "Standalone community features.",
    settings: [birthdaysSetting, nsfwSetting, linkFixSetting, retainMemberDataSetting],
  },
];

// Flat view, used by dispatch — subcommand names are unique across the
// whole command regardless of group, so lookup by name alone is enough.
export const settingDefinitions: readonly SettingDefinition[] = settingGroups.flatMap((group) => group.settings);

export const settingDefinitionsByName: ReadonlyMap<string, SettingDefinition> = new Map(
  settingDefinitions.map((definition) => [definition.name, definition]),
);
