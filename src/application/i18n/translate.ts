import type { Language } from "./language.js";
import { en, type MessageKey } from "./messages/en.js";
import { ja } from "./messages/ja.js";
import { zhTW } from "./messages/zh-TW.js";

export type { MessageKey } from "./messages/en.js";
export type MessageParams = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, params?: MessageParams) => string;

const catalogs: Readonly<Record<Language, Readonly<Record<MessageKey, string>>>> = {
  en,
  "zh-TW": zhTW,
  ja,
};

// Fills `{name}` placeholders. A placeholder with no matching param is left
// as-is (visibly wrong, but never throws in the middle of a Discord reply).
function interpolate(template: string, params: MessageParams | undefined): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}

export function translate(language: Language, key: MessageKey, params?: MessageParams): string {
  return interpolate(catalogs[language][key], params);
}

// A translate function bound to one language — what call sites usually want:
// `const t = translator(profile.language); t("panel.queue.title")`.
export function translator(language: Language): Translate {
  return (key, params) => translate(language, key, params);
}
