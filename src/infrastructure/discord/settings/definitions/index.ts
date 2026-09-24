import { ambientRepliesSetting } from "./ambient-replies-setting.js";
import { reactionRepliesSetting } from "./reaction-replies-setting.js";
import { historyReactionsSetting } from "./history-reactions-setting.js";
import { channelHistorySetting } from "./channel-history-setting.js";
import {
  contextDailyAddSetting,
  contextDailyRemoveSetting,
  contextRemoveSetting,
  contextScanAddSetting,
  contextStatusSetting,
} from "./channel-context-setting.js";
import { chatbotSetting } from "./chatbot-setting.js";
import type { SettingDefinition } from "./setting-definition.js";
import { templateSetting } from "./template-setting.js";
import { toolsDisableSetting, toolsEnableSetting, toolsListSetting } from "./tools-setting.js";

export type {
  FieldChange,
  MutationSettingDefinition,
  ReadOnlySettingDefinition,
  SettingDefinition,
  SettingDeps,
  SettingHandlerResult,
  SettingRequest,
  SettingValues,
} from "./setting-definition.js";

export interface SettingGroup {
  name: string;
  description: string;
  settings: readonly SettingDefinition[];
}

// The settings groups not yet moved to the settings registry (../groups),
// still run by LegacySettingsEngine. A group leaves this list when it's
// registered there.
export const settingGroups: readonly SettingGroup[] = [
  {
    name: "chat",
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
