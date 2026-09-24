import { accessSetting } from "./access-setting.js";
import { adminPanelSetting } from "./admin-panel-setting.js";
import { ambientRepliesSetting } from "./ambient-replies-setting.js";
import { reactionRepliesSetting } from "./reaction-replies-setting.js";
import { historyReactionsSetting } from "./history-reactions-setting.js";
import { auditSetting } from "./audit-setting.js";
import { auditLogSetting } from "./audit-log-setting.js";
import { birthdaysSetting } from "./birthdays-setting.js";
import { channelHistorySetting } from "./channel-history-setting.js";
import {
  contextDailyAddSetting,
  contextDailyRemoveSetting,
  contextRemoveSetting,
  contextScanAddSetting,
  contextStatusSetting,
} from "./channel-context-setting.js";
import { chatbotSetting } from "./chatbot-setting.js";
import { djModeSetting } from "./dj-mode-setting.js";
import { languageSetting } from "./language-setting.js";
import { lifecycleSetting } from "./lifecycle-setting.js";
import { linkFixSetting } from "./link-fix-setting.js";
import { nsfwSetting } from "./nsfw-setting.js";
import { autoQueueVoteSetting } from "./autoqueue-vote-setting.js";
import { openQueueRequestsSetting } from "./open-queue-requests-setting.js";
import { panelSetting } from "./panel-setting.js";
import { remindersSetting } from "./reminders-setting.js";
import { retainMemberDataSetting } from "./retain-member-data-setting.js";
import { roleAddSetting, roleRemoveSetting } from "./role-membership-setting.js";
import { rolesSetting } from "./roles-setting.js";
import type { SettingDefinition } from "./setting-definition.js";
import { templateSetting } from "./template-setting.js";
import { timezoneSetting } from "./timezone-setting.js";
import { toolsDisableSetting, toolsEnableSetting, toolsListSetting } from "./tools-setting.js";
import { volumeSetting } from "./volume-setting.js";
import { welcomeSetting } from "./welcome-setting.js";

export type {
  FieldChange,
  MutationSettingDefinition,
  ReadOnlySettingDefinition,
  SettingDefinition,
  SettingDeps,
  SettingHandlerResult,
  OptionPanelMetadata,
  PanelListOptionMetadata,
  SettingOptionMetadata,
  SettingRequest,
  SettingValues,
  SlashSettingOptionMetadata,
} from "./setting-definition.js";
export { isPanelListOption, slashOptionsOf } from "./setting-definition.js";

// One admin-panel message. `entries` lists settings in display order;
// `options` narrows a setting that spans several sections (chatbot) to the
// options shown in this one.
export interface PanelSectionDefinition {
  // Stable id — part of every control id on the section's message.
  name: string;
  title: string;
  entries: readonly { setting: string; options?: readonly string[] }[];
}

export interface SettingGroup {
  name: string;
  // Heading on the admin panel.
  title: string;
  description: string;
  settings: readonly SettingDefinition[];
  // How the group splits into admin-panel messages. Omitted means one
  // section showing every panel-capable setting in `settings` order.
  panelSections?: readonly PanelSectionDefinition[];
}

// Adding a setting: write one file next to these exporting a
// SettingDefinition, then add it to the right group's `settings` list below.
// Removing one: delete the file, remove it from its group. Adding a whole
// new group: add one entry to this list — /settings-<group> <setting> is
// built entirely from this structure (see buildDefinitionForGroup in
// commands/setup/settings-command.ts), and SettingsEngine runs it.
export const settingGroups: readonly SettingGroup[] = [
  {
    name: "access",
    title: "Access",
    description: "Roles, permissions, and audit logging.",
    settings: [accessSetting, rolesSetting, roleAddSetting, roleRemoveSetting, auditLogSetting, auditSetting, adminPanelSetting],
  },
  {
    name: "music",
    title: "Music",
    description: "Music panel and playback behavior.",
    settings: [panelSetting, volumeSetting, lifecycleSetting, djModeSetting, openQueueRequestsSetting, autoQueueVoteSetting],
  },
  {
    name: "chat",
    title: "Chat",
    description: "AI chat behavior.",
    settings: [
      chatbotSetting,
      ambientRepliesSetting,
      reactionRepliesSetting,
      historyReactionsSetting,
      channelHistorySetting,
      contextScanAddSetting,
      contextDailyAddSetting,
      contextDailyRemoveSetting,
      contextRemoveSetting,
      contextStatusSetting,
      templateSetting,
      toolsEnableSetting,
      toolsDisableSetting,
      toolsListSetting,
    ],
  },
  {
    name: "community",
    title: "Community",
    description: "Standalone community features.",
    settings: [birthdaysSetting, remindersSetting, welcomeSetting, nsfwSetting, linkFixSetting, retainMemberDataSetting, timezoneSetting, languageSetting],
  },
];

// Flat view, used by dispatch — subcommand names are unique across the
// whole command regardless of group, so lookup by name alone is enough.
export const settingDefinitions: readonly SettingDefinition[] = settingGroups.flatMap((group) => group.settings);

export const settingDefinitionsByName: ReadonlyMap<string, SettingDefinition> = new Map(
  settingDefinitions.map((definition) => [definition.name, definition]),
);

if (settingDefinitionsByName.size !== settingDefinitions.length) {
  const seen = new Set<string>();
  const duplicate = settingDefinitions.find((definition) => {
    if (seen.has(definition.name)) return true;
    seen.add(definition.name);
    return false;
  });
  throw new Error(`Duplicate setting name "${duplicate?.name}" registered across settingGroups.`);
}
