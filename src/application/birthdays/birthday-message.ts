import type { BirthdayDetails, BirthdayRecord } from "./birthday-store.js";
import type { Language } from "../i18n/language.js";
import { birthdayTexts } from "../i18n/birthday-text.js";

export const birthdayMessageLimit = 1_000;
const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function guildCalendarDate(now: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

export function validateBirthday(month: number, day: number, details: BirthdayDetails, currentYear: number, language: Language = "en"): string | null {
  const copy = birthdayTexts[language];
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > daysInMonth[month - 1]!) {
    return copy.invalidDate;
  }
  const year = details.birthYear;
  if (year != null && (!Number.isInteger(year) || year < 1900 || year > currentYear)) {
    return copy.invalidYear(currentYear);
  }
  if (year != null && month === 2 && day === 29 && new Date(Date.UTC(year, 1, 29)).getUTCMonth() !== 1) {
    return copy.invalidLeap;
  }
  if (details.message != null && (typeof details.message !== "string" || details.message.length > birthdayMessageLimit || !details.message.trim())) {
    return copy.invalidMessage(birthdayMessageLimit);
  }
  return null;
}

export function formatBirthdayDate(month: number, day: number, language: Language = "en"): string {
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : language, { timeZone: "UTC", month: "long", day: "numeric" }).format(new Date(Date.UTC(2000, month - 1, day)));
}

// Feb 29 birthdays are observed on March 1 during non-leap years.
export function birthdayOccurrence(record: BirthdayRecord, today: { year: number; month: number; day: number }): { date: Date; days: number; age: number | null } {
  const todayMs = Date.UTC(today.year, today.month - 1, today.day);
  let date = new Date(Date.UTC(today.year, record.month - 1, record.day));
  if (date.getTime() < todayMs) date = new Date(Date.UTC(today.year + 1, record.month - 1, record.day));
  return { date, days: Math.round((date.getTime() - todayMs) / 86_400_000), age: record.birthYear == null ? null : date.getUTCFullYear() - record.birthYear };
}

export function renderBirthdayMessage(template: string, record: BirthdayRecord, occurrence: ReturnType<typeof birthdayOccurrence>, language: Language = "en"): string {
  const copy = birthdayTexts[language];
  const age = occurrence.age;
  const values: Record<string, string> = {
    member: `<@${record.userId}>`,
    age: age == null ? "" : String(age),
    ordinal: age == null ? "" : copy.ordinal(age),
    birthday: age == null ? copy.birthday : copy.agedBirthday(age),
    days: String(occurrence.days),
    date: new Intl.DateTimeFormat(language === "en" ? "en-GB" : language, { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(occurrence.date),
  };
  return template.replace(/\{(member|age|ordinal|birthday|days|date)\}/g, (_, key: string) => values[key]!);
}

export const birthdayCountdownTemplate = birthdayTexts.en.countdownTemplate;
