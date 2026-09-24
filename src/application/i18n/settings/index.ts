import { defaultLanguage, languages, type Language } from "../language.js";
import type { Localizations } from "../../commands/command-metadata.js";
import type { SettingsNodeText, SettingsTextCatalogs } from "./catalog.js";
import { enSettingsText } from "./en/index.js";
import { jaSettingsText } from "./ja/index.js";
import { zhTWSettingsText } from "./zh-TW/index.js";

export type { SettingsNodeText, SettingsTextCatalog, SettingsTextCatalogs } from "./catalog.js";

export const settingsTextCatalogs: SettingsTextCatalogs = {
  en: enSettingsText,
  "zh-TW": zhTWSettingsText,
  ja: jaSettingsText,
};

type TextField = "title" | "label" | "description";

// Settings text in one language, falling back to English field by field.
// The registry's validation guarantees English has every field a node
// needs, so a lookup only falls back to the bare path for an unregistered
// path — a bug, and one that stays visible rather than blank.
export interface SettingsText {
  readonly language: Language;
  title(path: string): string;
  label(path: string): string;
  description(path: string): string;
  choice(path: string, value: string): string;
  message(path: string, name: string, params?: Readonly<Record<string, string | number>>): string;
}

export function settingsText(language: Language, catalogs: SettingsTextCatalogs = settingsTextCatalogs): SettingsText {
  const own = catalogs[language];
  const english = catalogs[defaultLanguage];
  const field = (path: string, name: TextField): string => own[path]?.[name] ?? english[path]?.[name] ?? path;
  const entry = (path: string, name: "choices" | "messages", key: string): string =>
    own[path]?.[name]?.[key] ?? english[path]?.[name]?.[key] ?? key;
  return {
    language,
    title: (path) => field(path, "title"),
    label: (path) => field(path, "label"),
    description: (path) => field(path, "description"),
    choice: (path, value) => entry(path, "choices", value),
    message: (path, name, params = {}) =>
      entry(path, "messages", name).replace(/\{(\w+)\}/g, (placeholder, key: string) =>
        key in params ? String(params[key]) : placeholder),
  };
}

// Discord-shaped { locale: text } for one field of one node, from every
// non-English catalog that has it (English is the base text). Null when no
// translation exists, so the builder leaves the node English-only.
export function settingsLocalizations(
  path: string,
  pick: (text: SettingsNodeText) => string | undefined,
  catalogs: SettingsTextCatalogs = settingsTextCatalogs,
): Localizations | null {
  const localizations: Record<string, string> = {};
  for (const language of languages) {
    if (language === defaultLanguage) continue;
    const text = catalogs[language][path];
    const value = text ? pick(text) : undefined;
    if (value !== undefined) localizations[language] = value;
  }
  return Object.keys(localizations).length > 0 ? localizations : null;
}
