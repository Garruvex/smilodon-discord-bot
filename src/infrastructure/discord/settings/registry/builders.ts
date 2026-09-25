import type {
  ActionNode,
  ChannelListOption,
  ChannelOption,
  ChoiceOption,
  IntegerOption,
  ReportNode,
  RoleListOption,
  RoleOption,
  SettingNode,
  SettingsGroup,
  SettingsNode,
  SettingsSection,
  TextOption,
  ToggleOption,
  UploadOption,
} from "./types.js";

// Small constructors so registrations read as data:
//
//   group("music", [
//     setting("dj-mode", {
//       enabled: toggle({ read: (p) => p.music.djModeEnabled, write: (v) => ({ djModeEnabled: v }) }),
//     }),
//   ])
//
// Names are the only identifiers anywhere: command, subcommand, text key,
// panel message and control id are all derived from the path they form.

type Spec<Option> = Omit<Option, "kind">;

export function group(name: string, nodes: readonly SettingsNode[]): SettingsGroup {
  return { kind: "group", name, nodes };
}

export function groupWithSections(name: string, sections: readonly SettingsSection[]): SettingsGroup {
  return { kind: "group", name, sections };
}

export function section(name: string, nodes: readonly SettingsNode[]): SettingsSection {
  return { kind: "section", name, nodes };
}

export function setting(
  name: string,
  options: SettingNode["options"],
  extras: Omit<SettingNode, "kind" | "name" | "options"> = {},
): SettingNode {
  return { kind: "setting", name, options, ...extras };
}

export function action(name: string, spec: Omit<ActionNode, "kind" | "name">): ActionNode {
  return { kind: "action", name, ...spec };
}

export function report(
  name: string,
  render: ReportNode["render"],
  params: NonNullable<ReportNode["params"]> = {},
): ReportNode {
  return { kind: "report", name, params, render };
}

export const toggle = (spec: Spec<ToggleOption>): ToggleOption => ({ kind: "toggle", ...spec });
export const choice = <const Choice extends string>(spec: Spec<ChoiceOption<Choice>>): ChoiceOption<Choice> =>
  ({ kind: "choice", ...spec });
export const integer = (spec: Spec<IntegerOption>): IntegerOption => ({ kind: "integer", ...spec });
export const text = (spec: Spec<TextOption>): TextOption => ({ kind: "text", ...spec });
export const channel = (spec: Spec<ChannelOption>): ChannelOption => ({ kind: "channel", ...spec });
export const role = (spec: Spec<RoleOption>): RoleOption => ({ kind: "role", ...spec });
export const channelList = (spec: Spec<ChannelListOption>): ChannelListOption => ({ kind: "channelList", ...spec });
export const roleList = (spec: Spec<RoleListOption>): RoleListOption => ({ kind: "roleList", ...spec });
export const upload = (spec: Spec<UploadOption>): UploadOption => ({ kind: "upload", ...spec });
