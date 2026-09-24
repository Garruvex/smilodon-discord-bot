import {
  isPanelListOption,
  settingGroups,
  type MutationSettingDefinition,
  type OptionPanelMetadata,
  type PanelSectionDefinition,
  type PanelListOptionMetadata,
  type ReadOnlySettingDefinition,
  type SettingDefinition,
  type SettingGroup,
  type SettingOptionMetadata,
  type SlashSettingOptionMetadata,
} from "./definitions/index.js";

// Discord allows at most five inputs in one modal.
export const maxModalFields = 5;

export type PanelOption = SlashSettingOptionMetadata & { panel: OptionPanelMetadata };

// One control on a setting's row, derived from its option's type:
// boolean → On/Off toggle, string with choices → select, channel/role →
// single picker, channelList/roleList → multi-select. Integer and free-text
// options aren't controls; they're the row's modal fields.
export type PanelControl =
  | { kind: "toggle"; option: PanelOption }
  | { kind: "choice"; option: PanelOption }
  | { kind: "channel"; option: PanelOption }
  | { kind: "role"; option: PanelOption }
  | { kind: "list"; option: PanelListOptionMetadata };

export interface PanelSettingRow {
  kind: "setting";
  groupName: string;
  setting: MutationSettingDefinition;
  controls: readonly PanelControl[];
  // Integer and free-text options, edited together in one modal.
  modalFields: readonly PanelOption[];
}

export interface PanelReportRow {
  kind: "report";
  groupName: string;
  setting: ReadOnlySettingDefinition;
}

export type PanelRow = PanelSettingRow | PanelReportRow;

export interface PanelSectionLayout {
  name: string;
  title: string;
  groupName: string;
  // The group's description, shown under the title.
  description: string;
  rows: readonly PanelRow[];
}

// The admin panel's structure, derived entirely from the settings registry:
// which settings appear, in which section, with which controls. Throws on a
// registry mistake (unknown setting or option in panelSections, an option
// type the panel can't show, too many modal fields) so it fails at startup
// and in tests rather than rendering a broken panel.
export function buildPanelLayout(groups: readonly SettingGroup[] = settingGroups): readonly PanelSectionLayout[] {
  const sections: PanelSectionLayout[] = [];
  const seenSections = new Set<string>();
  // "setting:option" — each option's control lives in exactly one section,
  // so a control id always maps back to one message.
  const seenOptions = new Set<string>();

  for (const group of groups) {
    const definitions: readonly PanelSectionDefinition[] = group.panelSections ?? [{
      name: group.name,
      title: group.title,
      entries: group.settings.map((setting) => ({ setting: setting.name })),
    }];

    for (const definition of definitions) {
      if (seenSections.has(definition.name)) {
        throw new Error(`Duplicate admin-panel section "${definition.name}".`);
      }
      seenSections.add(definition.name);

      const rows: PanelRow[] = [];
      for (const entry of definition.entries) {
        const setting = group.settings.find((candidate) => candidate.name === entry.setting);
        if (!setting) {
          throw new Error(`Admin-panel section "${definition.name}" lists "${entry.setting}", which isn't a setting in group "${group.name}".`);
        }
        const row = buildRow(group.name, setting, entry.options);
        if (!row) continue;
        if (row.kind === "setting") {
          for (const option of [...row.controls.map((control) => control.option), ...row.modalFields]) {
            const key = `${setting.name}:${option.name}`;
            if (seenOptions.has(key)) throw new Error(`Admin-panel option "${key}" appears in more than one section.`);
            seenOptions.add(key);
          }
        }
        rows.push(row);
      }
      if (rows.length > 0) {
        sections.push({
          name: definition.name,
          title: definition.title,
          groupName: group.name,
          description: group.description,
          rows,
        });
      }
    }
  }
  return sections;
}

function buildRow(
  groupName: string,
  setting: SettingDefinition,
  onlyOptions: readonly string[] | undefined,
): PanelRow | null {
  if (setting.kind === "readOnly") {
    return setting.panelReport ? { kind: "report", groupName, setting } : null;
  }

  const options = setting.configureOptions?.() ?? [];
  for (const name of onlyOptions ?? []) {
    if (!options.some((option) => option.name === name && option.panel)) {
      throw new Error(`Setting "${setting.name}" has no panel option "${name}".`);
    }
  }

  const controls: PanelControl[] = [];
  const modalFields: PanelOption[] = [];
  for (const option of options) {
    if (!option.panel) continue;
    if (onlyOptions && !onlyOptions.includes(option.name)) continue;
    const control = controlFor(setting.name, option);
    if (control) controls.push(control);
    else modalFields.push(option as PanelOption);
  }

  if (modalFields.length > maxModalFields) {
    throw new Error(`Setting "${setting.name}" has ${modalFields.length} modal fields on one panel row; Discord allows ${maxModalFields}.`);
  }
  if (controls.length === 0 && modalFields.length === 0) return null;
  return { kind: "setting", groupName, setting, controls, modalFields };
}

// Null means "not a control": the option is edited in the row's modal.
function controlFor(settingName: string, option: SettingOptionMetadata): PanelControl | null {
  if (isPanelListOption(option)) return { kind: "list", option };
  const panelOption = option as PanelOption;
  switch (option.type) {
    case "boolean":
      return { kind: "toggle", option: panelOption };
    case "string":
      return option.choices ? { kind: "choice", option: panelOption } : null;
    case "integer":
      return null;
    case "channel":
      return { kind: "channel", option: panelOption };
    case "role":
      return { kind: "role", option: panelOption };
    case "user":
    case "attachment":
      throw new Error(`Setting "${settingName}" option "${option.name}" (${option.type}) can't be shown on the admin panel.`);
  }
}
