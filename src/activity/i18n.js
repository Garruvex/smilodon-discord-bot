import { app } from "./state.js";
import { fetchWithTimeout } from "./api.js";

// A class as the game's language names it; an unknown class shows as written.
export function classText(raw) {
  if (!raw) return raw;
  const translated = app.activityStrings[`activity.creator.classOption.${raw.toLowerCase()}`];
  return translated ?? app.classNames[raw.toLowerCase()] ?? raw;
}


export function t(key, values = {}) {
  const message = app.activityStrings[key] ?? key;
  return message.replace(/\{(\w+)\}/g, (_, name) => values[name] === undefined ? `{${name}}` : String(values[name]));
}


export function applyStaticTranslations() {
  for (const element of document.querySelectorAll("[data-i18n]")) element.textContent = t(element.dataset.i18n);
  for (const element of document.querySelectorAll("[data-i18n-aria-label]")) element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  for (const element of document.querySelectorAll("[data-i18n-placeholder]")) element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder));
  for (const element of document.querySelectorAll("[data-i18n-title]")) element.setAttribute("title", t(element.dataset.i18nTitle));
}


export async function setLanguage(language) {
  const normalized = language === "zh-TW" ? "zh-TW" : "en";
  if (normalized === app.uiLanguage && Object.keys(app.activityStrings).length > 0) return;
  let response = await fetchWithTimeout(`/api/activity/i18n?language=${encodeURIComponent(normalized)}`, { cache: "no-store" });
  // Static preview servers may serve their index page (200 HTML) for unknown
  // API routes. Treat that as a miss so local previews load their bundled text.
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    response = await fetchWithTimeout(`/i18n/${encodeURIComponent(normalized)}.json`, { cache: "no-store" });
  }
  if (!response.ok) throw new Error(t("activity.connection.requestFailed"));
  app.activityStrings = await response.json();
  app.uiLanguage = normalized;
  document.documentElement.lang = normalized;
  const selector = document.querySelector("#activity-language");
  if (selector) selector.value = app.languagePreference ?? "auto";
  applyStaticTranslations();
}


export function languageFromDiscordLocale(locale) {
  return typeof locale === "string" && (/^zh-TW(?:$|-)/i.test(locale) || /^zh-Hant(?:$|-)/i.test(locale)) ? "zh-TW" : "en";
}

export function languageFromBrowser() {
  return languageFromDiscordLocale(globalThis.navigator?.languages?.[0] ?? globalThis.navigator?.language);
}

