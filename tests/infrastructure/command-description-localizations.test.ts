/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";

import type { ChatInputCommandMetadata } from "../../src/application/commands/command-metadata.js";
import {
  commandDescriptionCatalogs,
  commandDescriptionKey,
} from "../../src/application/i18n/command-descriptions/index.js";
import { buildSlashCommandBuilder } from "../../src/infrastructure/discord/commands/command-metadata-builder.js";
import { BooruSearchCommand } from "../../src/infrastructure/discord/commands/image/booru-search-command.js";
import { FurryReactionCommand } from "../../src/infrastructure/discord/commands/image/furry-reaction-command.js";
import { RandomAnimalFactCommand } from "../../src/infrastructure/discord/commands/image/random-animal-fact-command.js";
import { buildDefinitionForGroup } from "../../src/infrastructure/discord/commands/setup/settings-command.js";
import { settingGroups } from "../../src/infrastructure/discord/commands/setup/settings/index.js";

// Every command module under commands/, loaded eagerly so a newly added
// command is covered without editing this test.
const commandModules = import.meta.glob<Record<string, unknown>>(
  "../../src/infrastructure/discord/commands/**/*-command.ts",
  { eager: true },
);

// Commands whose constructor takes real configuration (not services), so
// they can't be built from stubs — bootstrap/dependencies.ts registers them
// in loops, which this mirrors.
const explicitlyBuilt = new Set([
  "SettingsCommand",
  "FurryReactionCommand",
  "RandomAnimalFactCommand",
  "BooruSearchCommand",
]);

// Constructors of the remaining commands only store their dependencies, so
// an inert stand-in for each is enough to read `definition`.
const inertDependency: unknown = new Proxy(() => undefined, {
  get: () => inertDependency,
  apply: () => inertDependency,
});

function allDefinitions(): ChatInputCommandMetadata[] {
  const definitions: ChatInputCommandMetadata[] = [];
  for (const module of Object.values(commandModules)) {
    for (const [exportName, exported] of Object.entries(module)) {
      if (!exportName.endsWith("Command") || typeof exported !== "function") continue;
      if (explicitlyBuilt.has(exportName)) continue;
      const Command = exported as new (...args: unknown[]) => { definition: { type?: string } };
      const { definition } = new Command(...Array<unknown>(8).fill(inertDependency));
      // Message context-menu commands have no description to translate.
      if (definition.type !== "messageContextMenu") definitions.push(definition as ChatInputCommandMetadata);
    }
  }
  for (const species of ["bird", "cat", "dog", "fox", "raccoon"]) {
    definitions.push(new RandomAnimalFactCommand(species, "", "").definition);
  }
  for (const key of ["boop", "hold", "howl", "hug", "kiss", "lick", "bulge", "butts"]) {
    definitions.push(new FurryReactionCommand(key, `Gets a random ${key} image.`, "", "", "", false).definition);
  }
  definitions.push(new BooruSearchCommand("e926", "#66FF33", false).definition);
  definitions.push(new BooruSearchCommand("e621", "#09CDE2", true).definition);
  for (const group of settingGroups) definitions.push(buildDefinitionForGroup(group));
  return definitions;
}

function descriptionKeys(definition: ChatInputCommandMetadata): string[] {
  const keys = [commandDescriptionKey([definition.name])];
  const options = (path: string[], list: ChatInputCommandMetadata["options"]): void => {
    for (const option of list ?? []) keys.push(commandDescriptionKey(path, option.name));
  };
  options([definition.name], definition.options);
  for (const subcommand of definition.subcommands ?? []) {
    const path = [definition.name, subcommand.name];
    keys.push(commandDescriptionKey(path));
    options(path, subcommand.options);
  }
  for (const group of definition.subcommandGroups ?? []) {
    keys.push(commandDescriptionKey([definition.name, group.name]));
    for (const subcommand of group.subcommands) {
      const path = [definition.name, group.name, subcommand.name];
      keys.push(commandDescriptionKey(path));
      options(path, subcommand.options);
    }
  }
  return keys;
}

// Discord's cap on a description, in characters — localized ones included.
const descriptionLimit = 100;

// Discord's cap on a command's total name + description (+ choice) text. It
// is unclear whether localized descriptions count toward it, so they are
// counted here to stay safe. Kept well under the 8000 hard cap for headroom,
// like settings-command-metadata.test.ts.
const totalSizeThreshold = 6000;

function totalSize(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const record = node as Record<string, unknown>;
  let total = 0;
  if (typeof record.name === "string") total += record.name.length;
  if (typeof record.description === "string") total += record.description.length;
  const localizations = record.description_localizations;
  if (localizations && typeof localizations === "object") {
    for (const value of Object.values(localizations)) if (typeof value === "string") total += value.length;
  }
  for (const choice of (record.choices as unknown[] | undefined) ?? []) {
    if (!choice || typeof choice !== "object") continue;
    const { name, value } = choice as Record<string, unknown>;
    if (typeof name === "string") total += name.length;
    if (typeof value === "string") total += value.length;
  }
  for (const child of (record.options as unknown[] | undefined) ?? []) total += totalSize(child);
  return total;
}

describe("slash-command description localizations", () => {
  const locales = Object.keys(commandDescriptionCatalogs);
  const definitions = allDefinitions();
  const realKeys = new Set(definitions.flatMap(descriptionKeys));

  it("covers zh-TW and ja", () => {
    expect(locales.sort()).toEqual(["ja", "zh-TW"]);
  });

  it("finds the bot's commands (guards the discovery above)", () => {
    expect(realKeys.has("ping")).toBe(true);
    expect(realKeys.has("play:query")).toBe(true);
    expect(realKeys.has("settings-chat/chatbot:enabled")).toBe(true);
    expect(realKeys.has("cat")).toBe(true);
    expect(realKeys.has("e621:order")).toBe(true);
  });

  for (const locale of Object.keys(commandDescriptionCatalogs)) {
    describe(locale, () => {
      const catalog = commandDescriptionCatalogs[locale]!;

      it("translates every command, subcommand and option description", () => {
        const untranslated = [...realKeys].filter((key) => catalog[key] === undefined);
        expect(untranslated).toEqual([]);
      });

      it("has no entry for a command or option that no longer exists", () => {
        const stale = Object.keys(catalog).filter((key) => !realKeys.has(key));
        expect(stale).toEqual([]);
      });

      it(`keeps every description within Discord's ${descriptionLimit}-character limit`, () => {
        for (const [key, description] of Object.entries(catalog)) {
          expect(description.length, key).toBeGreaterThan(0);
          expect(description.length, key).toBeLessThanOrEqual(descriptionLimit);
        }
      });
    });
  }

  it("builds every command with description_localizations, within Discord's size limits", () => {
    for (const definition of definitions) {
      const json = buildSlashCommandBuilder(definition).toJSON();
      expect(Object.keys(json.description_localizations ?? {}).sort(), definition.name).toEqual(["ja", "zh-TW"]);
      expect(totalSize(json), `command "${definition.name}"`).toBeLessThanOrEqual(totalSizeThreshold);
    }
  });

  it("localizes subcommands and options, and leaves names in English", () => {
    const json = buildSlashCommandBuilder({
      name: "birthday",
      description: "Manages birthdays.",
      subcommands: [
        {
          name: "set",
          description: "Sets your birthday.",
          options: [{ type: "integer", name: "month", description: "Birth month." }],
        },
      ],
    }).toJSON();

    expect(json.name).toBe("birthday");
    expect(json.name_localizations).toBeUndefined();
    const subcommand = json.options?.[0] as { name: string; name_localizations?: unknown; description_localizations?: Record<string, string>; options?: { description_localizations?: Record<string, string> }[] };
    expect(subcommand.name).toBe("set");
    expect(subcommand.name_localizations).toBeUndefined();
    expect(subcommand.description_localizations?.ja).toBe(commandDescriptionCatalogs.ja!["birthday/set"]);
    expect(subcommand.options?.[0]?.description_localizations?.["zh-TW"]).toBe(
      commandDescriptionCatalogs["zh-TW"]!["birthday/set:month"],
    );
  });

  it("leaves a command without a catalog entry with just its English description", () => {
    const json = buildSlashCommandBuilder({ name: "not-in-any-catalog", description: "English only." }).toJSON();
    expect(json.description).toBe("English only.");
    expect(json.description_localizations).toBeUndefined();
  });
});
