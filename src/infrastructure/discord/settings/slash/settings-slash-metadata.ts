import type {
  ChatInputCommandMetadata,
  CommandOptionMetadata,
  Localizations,
  SubcommandMetadata,
} from "../../../../application/commands/command-metadata.js";
import { defaultLanguage, languages } from "../../../../application/i18n/language.js";
import {
  settingsLocalizations,
  settingsText,
  settingsTextCatalogs,
  type SettingsTextCatalogs,
} from "../../../../application/i18n/settings/index.js";
import { texts } from "../../../../application/i18n/texts.js";
import { clearSlashOptionName, commandNameFor, listSlashOptionNames, optionPath, sectionPath } from "../registry/paths.js";
import type { ActionParam, SettingOption, SettingsGroup, SettingsNode } from "../registry/types.js";

type Described = { description: string; descriptionLocalizations?: Localizations };

// A settings group's slash command, derived from the registry: the group is
// `/settings-<group>`, a section a subcommand group, a node a subcommand,
// an option an option. Descriptions and choice names come from the settings
// catalogs, with every translation embedded, so these commands need nothing
// in the command-description catalogs.
export function buildSettingsCommandMetadata(
  group: SettingsGroup,
  catalogs: SettingsTextCatalogs = settingsTextCatalogs,
): ChatInputCommandMetadata {
  const described = (path: string): Described => {
    const localizations = settingsLocalizations(path, (text) => text.description, catalogs);
    return {
      description: settingsText(defaultLanguage, catalogs).description(path),
      ...(localizations ? { descriptionLocalizations: localizations } : {}),
    };
  };
  const subcommand = (path: string, node: SettingsNode): SubcommandMetadata => ({
    name: node.name,
    ...described(path),
    options: requiredFirst(nodeOptions(path, node, catalogs, described)),
  });

  return {
    name: commandNameFor(group),
    ...described(group.name),
    ...(group.sections
      ? {
        subcommandGroups: group.sections.map((section) => {
          const path = sectionPath(group, section);
          return {
            name: section.name,
            ...described(path),
            subcommands: section.nodes.map((node) => subcommand(`${path}.${node.name}`, node)),
          };
        }),
      }
      : { subcommands: group.nodes.map((node) => subcommand(`${group.name}.${node.name}`, node)) }),
  };
}

function nodeOptions(
  path: string,
  node: SettingsNode,
  catalogs: SettingsTextCatalogs,
  described: (path: string) => Described,
): CommandOptionMetadata[] {
  switch (node.kind) {
    case "report":
    case "action":
      return Object.entries(node.params ?? {}).map(([name, param]) =>
        slashOption(name, optionPath(path, name), param, catalogs, described));
    case "setting":
      return Object.entries(node.options).flatMap(([name, option]) => {
        const key = optionPath(path, name);
        if (option.kind === "channel" && option.clearable) {
          return [
            slashOption(name, key, option, catalogs, described),
            { type: "boolean" as const, name: clearSlashOptionName(node, name), ...derivedDescription(key, "clear", catalogs) },
          ];
        }
        if (option.kind !== "channelList" && option.kind !== "roleList") {
          return [slashOption(name, key, option, catalogs, described)];
        }
        const names = listSlashOptionNames(node, name);
        const type = option.kind === "channelList" ? "channel" as const : "role" as const;
        const textOnly = option.kind === "channelList" && option.textOnly;
        return [
          { type, name: names.add, ...derivedDescription(key, "add", catalogs), ...(textOnly ? { guildTextOnly: true } : {}) },
          { type, name: names.remove, ...derivedDescription(key, "remove", catalogs), ...(textOnly ? { guildTextOnly: true } : {}) },
        ];
      });
  }
}

function slashOption(
  name: string,
  path: string,
  option: SettingOption | ActionParam,
  catalogs: SettingsTextCatalogs,
  described: (path: string) => Described,
): CommandOptionMetadata {
  const base = { name, ...described(path), ...(option.required ? { required: true } : {}) };
  switch (option.kind) {
    case "toggle":
      return { type: "boolean", ...base };
    case "choice":
      return {
        type: "string",
        ...base,
        choices: option.choices.map((value) => {
          const localizations = settingsLocalizations(path, (text) => text.choices?.[value], catalogs);
          return {
            name: settingsText(defaultLanguage, catalogs).choice(path, value),
            value,
            ...(localizations ? { nameLocalizations: localizations } : {}),
          };
        }),
      };
    case "integer":
      return { type: "integer", ...base, minValue: option.min, maxValue: option.max };
    case "text":
      return { type: "string", ...base, maxLength: option.maxLength };
    case "channel":
      return { type: "channel", ...base, ...(option.textOnly ? { guildTextOnly: true } : {}) };
    case "role":
      return { type: "role", ...base };
    case "upload":
      return { type: "attachment", ...base };
    case "channelList":
    case "roleList":
      throw new Error(`List option "${path}" is expanded into add/remove options, not built directly.`);
  }
}

// "Add to: Allowed channels", "Clear: Audit log channel" — the options a
// list or clearable channel derives, described from the option's own label
// in each language, so they're translated wherever the label is.
function derivedDescription(path: string, operation: "add" | "remove" | "clear", catalogs: SettingsTextCatalogs): Described {
  const describe = (language: (typeof languages)[number]): string => {
    const label = settingsText(language, catalogs).label(path);
    const slash = texts[language].settings.slash;
    switch (operation) {
      case "add":
        return slash.listAdd({ label });
      case "remove":
        return slash.listRemove({ label });
      case "clear":
        return slash.clear({ label });
    }
  };
  const localizations: Record<string, string> = {};
  for (const language of languages) {
    if (language !== defaultLanguage && catalogs[language][path]?.label !== undefined) {
      localizations[language] = describe(language);
    }
  }
  return {
    description: describe(defaultLanguage),
    ...(Object.keys(localizations).length > 0 ? { descriptionLocalizations: localizations } : {}),
  };
}

// Discord requires required options before optional ones.
function requiredFirst(options: CommandOptionMetadata[]): CommandOptionMetadata[] {
  return [...options.filter((option) => option.required), ...options.filter((option) => !option.required)];
}
