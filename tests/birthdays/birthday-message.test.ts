import { describe, expect, it } from "vitest";
import { birthdayCountdownTemplate, birthdayOccurrence, guildCalendarDate, renderBirthdayMessage, validateBirthday } from "../../src/application/birthdays/birthday-message.js";
import { birthdayTexts } from "../../src/application/i18n/birthday-text.js";

describe("birthday messages", () => {
  it.each([
    { language: "zh-TW" as const, birthday: "28 歲生日", ordinal: "28 歲", unknown: "生日" },
    { language: "ja" as const, birthday: "28歳の誕生日", ordinal: "28歳", unknown: "誕生日" },
  ])("localizes generated values while preserving custom wording ($language)", ({ language, birthday, ordinal, unknown }) => {
    const record = { userId: "member", month: 8, day: 17, birthYear: 1999 };
    const next = birthdayOccurrence(record, { year: 2026, month: 10, day: 4 });
    const rendered = renderBirthdayMessage("CUSTOM: {birthday} / {ordinal} / {date} / {member} / {age} / {days}", record, next, language);
    expect(rendered).toBe(`CUSTOM: ${birthday} / ${ordinal} / 2027年8月17日 / <@member> / 28 / 317`);
    const withoutYear = { userId: "member", month: 8, day: 17 };
    expect(renderBirthdayMessage("{birthday}|{age}|{ordinal}", withoutYear, birthdayOccurrence(withoutYear, { year: 2026, month: 10, day: 4 }), language)).toBe(`${unknown}||`);
    expect(renderBirthdayMessage(birthdayTexts[language].countdownTemplate, record, next, language)).not.toContain("birthday");
  });
  it("calculates a real next birthday and the age reached on that date", () => {
    const record = { userId: "member", month: 8, day: 17, birthYear: 1999 };
    const next = birthdayOccurrence(record, { year: 2026, month: 10, day: 4 });
    expect(next.days).toBe(317);
    expect(next.age).toBe(28);
    expect(renderBirthdayMessage(birthdayCountdownTemplate, record, next)).toContain("**28th birthday** is in **317** days, on **17 August 2027**");
  });

  it("does not invent an age when the year is unknown", () => {
    const record = { userId: "member", month: 1, day: 1 };
    const next = birthdayOccurrence(record, { year: 2026, month: 1, day: 1 });
    expect(next.age).toBeNull();
    expect(next.days).toBe(0);
    expect(renderBirthdayMessage("{member}: {birthday} {age} {ordinal}", record, next)).toBe("<@member>: birthday  ");
  });

  it("counts actual leap days and observes Feb 29 on March 1 in non-leap years", () => {
    expect(birthdayOccurrence({ userId: "u", month: 3, day: 1 }, { year: 2028, month: 2, day: 28 }).days).toBe(2);
    const next = birthdayOccurrence({ userId: "u", month: 2, day: 29, birthYear: 2000 }, { year: 2027, month: 3, day: 1 });
    expect(next.days).toBe(0);
    expect(next.date.toISOString().slice(0, 10)).toBe("2027-03-01");
  });

  it("uses the server's local calendar date", () => {
    expect(guildCalendarDate(new Date("2026-12-31T18:00:00Z"), "Asia/Taipei")).toEqual({ year: 2027, month: 1, day: 1 });
  });

  it("rejects future years, invalid leap birth dates, and oversized messages", () => {
    expect(validateBirthday(8, 17, { birthYear: 2027 }, 2026)).not.toBeNull();
    expect(validateBirthday(2, 29, { birthYear: 1999 }, 2026)).not.toBeNull();
    expect(validateBirthday(2, 29, { birthYear: 2000 }, 2026)).toBeNull();
    expect(validateBirthday(8, 17, { message: "x".repeat(1001) }, 2026)).not.toBeNull();
  });
});
