import { defaultLanguage, languages } from "../../../../application/i18n/language.js";
import {
  settingsTextCatalogs,
  type SettingsNodeText,
  type SettingsTextCatalogs,
} from "../../../../application/i18n/settings/index.js";
import { clearSlashOptionName, commandNameFor, listSlashOptionNames, optionPath, sectionPath } from "./paths.js";
import type { SettingsGroup, SettingsNode } from "./types.js";

// Discord's limits on what the registry turns into slash commands and panel
// forms.
const namePattern = /^[a-z0-9-]{1,32}$/;
const maxEntries = 25;
const maxDescription = 100;
const maxLabel = 45;
const maxChoiceName = 100;
const maxFormFields = 5;

type Field = "title" | "label" | "description";

interface TextRequirement {
  path: string;
  fields: readonly Field[];
  choices?: readonly string[];
}

// Everything wrong with a registry and its text, as readable lines. Checked
// at startup (assertValidRegistry) and in tests, so a bad registration fails
// before it can deploy a broken command or render a broken panel.
export function registryProblems(
  groups: readonly SettingsGroup[],
  catalogs: SettingsTextCatalogs = settingsTextCatalogs,
): string[] {
  const problems: string[] = [];
  const required: TextRequirement[] = [];

  const checkName = (name: string, what: string): void => {
    if (!namePattern.test(name)) problems.push(`${what} "${name}" must be 1-32 lowercase letters, digits or dashes.`);
  };
  const checkUnique = (names: readonly string[], where: string): void => {
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) problems.push(`"${name}" is registered twice in ${where}.`);
      seen.add(name);
    }
  };
  const checkCount = (count: number, what: string): void => {
    if (count > maxEntries) problems.push(`${what} has ${count} entries; Discord allows ${maxEntries}.`);
  };

  const checkNode = (path: string, node: SettingsNode): void => {
    checkName(node.name, "Setting");
    required.push({ path, fields: node.kind === "report" ? ["description"] : ["label", "description"] });

    const entries = node.kind === "setting" ? Object.entries(node.options) : Object.entries(node.params ?? {});
    let slashOptions = 0;
    let formFields = 0;
    for (const [name, option] of entries) {
      checkName(name, "Option");
      const key = optionPath(path, name);
      required.push({
        path: key,
        fields: ["label", "description"],
        ...(option.kind === "choice" ? { choices: option.choices } : {}),
      });
      if (option.kind === "choice") {
        if (option.choices.length === 0) problems.push(`${key} has no choices.`);
        checkCount(option.choices.length, `${key}'s choices`);
      }
      if (option.kind === "integer" || option.kind === "text") formFields += 1;
      if (node.kind === "setting" && (option.kind === "channelList" || option.kind === "roleList")) {
        const names = listSlashOptionNames(node, name);
        checkName(names.add, "Option");
        checkName(names.remove, "Option");
        slashOptions += 2;
      } else if (node.kind === "setting" && option.kind === "channel" && option.clearable) {
        checkName(clearSlashOptionName(node, name), "Option");
        slashOptions += 2;
      } else {
        slashOptions += 1;
      }
    }
    checkCount(slashOptions, `${path}'s slash options`);
    if (formFields > maxFormFields) {
      problems.push(`${path} has ${formFields} typed fields; an edit form holds ${maxFormFields}.`);
    }
  };

  checkUnique(groups.map((group) => group.name), "the settings registry");
  for (const group of groups) {
    checkName(group.name, "Group");
    checkName(commandNameFor(group), "Command");
    required.push({ path: group.name, fields: ["title", "description"] });

    if (group.sections) {
      checkUnique(group.sections.map((section) => section.name), `group "${group.name}"`);
      checkCount(group.sections.length, `/${commandNameFor(group)}'s sections`);
      for (const section of group.sections) {
        const path = sectionPath(group, section);
        checkName(section.name, "Section");
        required.push({ path, fields: ["title", "description"] });
        checkUnique(section.nodes.map((node) => node.name), `section "${path}"`);
        checkCount(section.nodes.length, `section "${path}"`);
        for (const node of section.nodes) checkNode(`${path}.${node.name}`, node);
      }
    } else {
      checkUnique(group.nodes.map((node) => node.name), `group "${group.name}"`);
      checkCount(group.nodes.length, `/${commandNameFor(group)}`);
      for (const node of group.nodes) checkNode(`${group.name}.${node.name}`, node);
    }
  }

  problems.push(...textProblems(required, catalogs));
  return problems;
}

export function assertValidRegistry(
  groups: readonly SettingsGroup[],
  catalogs: SettingsTextCatalogs = settingsTextCatalogs,
): void {
  const problems = registryProblems(groups, catalogs);
  if (problems.length > 0) throw new Error(`Invalid settings registry:\n- ${problems.join("\n- ")}`);
}

function textProblems(required: readonly TextRequirement[], catalogs: SettingsTextCatalogs): string[] {
  const problems: string[] = [];
  const registered = new Set(required.map((requirement) => requirement.path));

  // English is the base text: every field a node needs must be there.
  const english = catalogs[defaultLanguage];
  for (const { path, fields, choices } of required) {
    for (const field of fields) {
      if (english[path]?.[field] === undefined) problems.push(`English text is missing ${field} for "${path}".`);
    }
    for (const value of choices ?? []) {
      if (english[path]?.choices?.[value] === undefined) {
        problems.push(`English text is missing the name of choice "${value}" for "${path}".`);
      }
    }
  }

  for (const language of languages) {
    for (const [path, text] of Object.entries(catalogs[language])) {
      if (!registered.has(path)) {
        problems.push(`${language} settings text has "${path}", which isn't registered.`);
        continue;
      }
      problems.push(...lengthProblems(language, path, text));
    }
  }
  return problems;
}

function lengthProblems(language: string, path: string, text: SettingsNodeText): string[] {
  const problems: string[] = [];
  const check = (value: string | undefined, limit: number, what: string): void => {
    if (value !== undefined && (value.length === 0 || value.length > limit)) {
      problems.push(`${language} ${what} for "${path}" must be 1-${limit} characters.`);
    }
  };
  check(text.title, maxDescription, "title");
  check(text.description, maxDescription, "description");
  check(text.label, maxLabel, "label");
  for (const [value, name] of Object.entries(text.choices ?? {})) check(name, maxChoiceName, `choice "${value}"`);
  return problems;
}
