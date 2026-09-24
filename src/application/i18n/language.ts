// The languages the bot can speak. A server picks one (GuildConfiguration
// .language, set via /settings-community language) and everything the bot
// posts for that server follows it — the music panel, announcements, votes,
// and replies alike. Values are Discord locale codes, so they line up with
// the slash-command description catalogs (./command-descriptions).
export const languages = ["en", "zh-TW", "ja"] as const;

export type Language = (typeof languages)[number];

export const defaultLanguage: Language = "en";

// Shown to admins in /settings-community language.
export const languageDisplayNames: Readonly<Record<Language, string>> = {
  en: "English",
  "zh-TW": "繁體中文",
  ja: "日本語",
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (languages as readonly string[]).includes(value);
}
