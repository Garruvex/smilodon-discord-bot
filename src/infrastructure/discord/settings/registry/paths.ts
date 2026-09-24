import type { ListOption, SettingNode, SettingsGroup, SettingsNode, SettingsSection } from "./types.js";

// A node with everything derived from where it's registered.
export interface RegisteredNode {
  // Text key and panel identity: "music.dj-mode", "chat.abilities.web-search".
  path: string;
  group: SettingsGroup;
  section: SettingsSection | null;
  node: SettingsNode;
  // Slash location: /<commandName> [subcommandGroup] <node.name>.
  commandName: string;
  subcommandGroup: string | null;
}

export function commandNameFor(group: SettingsGroup): string {
  return `settings-${group.name}`;
}

export function sectionPath(group: SettingsGroup, section: SettingsSection): string {
  return `${group.name}.${section.name}`;
}

export function optionPath(nodePath: string, optionName: string): string {
  return `${nodePath}.${optionName}`;
}

// Registry order: groups, then sections, then nodes as registered.
export function registeredNodes(groups: readonly SettingsGroup[]): RegisteredNode[] {
  return groups.flatMap((group): RegisteredNode[] => {
    const commandName = commandNameFor(group);
    if (group.sections) {
      return group.sections.flatMap((section) => section.nodes.map((node) => ({
        path: `${sectionPath(group, section)}.${node.name}`,
        group,
        section,
        node,
        commandName,
        subcommandGroup: section.name,
      })));
    }
    return group.nodes.map((node) => ({
      path: `${group.name}.${node.name}`,
      group,
      section: null,
      node,
      commandName,
      subcommandGroup: null,
    }));
  });
}

export function isListOption(option: SettingNode["options"][string]): option is ListOption {
  return option.kind === "channelList" || option.kind === "roleList";
}

// The slash options a list option becomes. A node whose only option is the
// list gets plain `add` / `remove`; otherwise they're named after the list.
export function listSlashOptionNames(node: SettingNode, optionName: string): { add: string; remove: string } {
  return Object.keys(node.options).length === 1
    ? { add: "add", remove: "remove" }
    : { add: `add-${optionName}`, remove: `remove-${optionName}` };
}
