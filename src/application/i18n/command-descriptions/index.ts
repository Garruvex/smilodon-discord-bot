import { jaCommandDescriptions } from "./ja.js";
import { zhTWCommandDescriptions } from "./zh-TW.js";
import type { CommandDescriptionCatalog } from "./catalog.js";

export { commandDescriptionKey, type CommandDescriptionCatalog } from "./catalog.js";

// Discord locale codes (the same strings as discord.js's Locale enum) for
// every language that has a description catalog. Slash-command descriptions
// are shown to each user in their own client language, so adding a language
// here is all deploy-time registration needs.
const catalogs = {
  "zh-TW": zhTWCommandDescriptions,
  ja: jaCommandDescriptions,
} as const satisfies Readonly<Record<string, CommandDescriptionCatalog<keyof typeof jaCommandDescriptions>>>;

// Keep the public lookup surface string-indexable; `catalogs` above provides
// the stricter compile-time check that every locale has the same keys.
export const commandDescriptionCatalogs: Readonly<Record<string, CommandDescriptionCatalog>> = catalogs;

// Discord-shaped { locale: description } map for one key, or null when no
// catalog has an entry for it.
export function localizedDescriptionsFor(key: string): Record<string, string> | null {
  const localizations: Record<string, string> = {};
  for (const [locale, catalog] of Object.entries(commandDescriptionCatalogs)) {
    const description = catalog[key];
    if (description !== undefined) localizations[locale] = description;
  }
  return Object.keys(localizations).length > 0 ? localizations : null;
}
