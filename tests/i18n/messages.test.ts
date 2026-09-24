import { describe, expect, it } from "vitest";

import { defaultLanguage, isLanguage, languageDisplayNames, languages } from "../../src/application/i18n/language.js";
import { en } from "../../src/application/i18n/messages/en.js";
import { ja } from "../../src/application/i18n/messages/ja.js";
import { zhTW } from "../../src/application/i18n/messages/zh-TW.js";
import { translate, translator } from "../../src/application/i18n/translate.js";

const catalogs = { en, "zh-TW": zhTW, ja } as const;

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

describe("language", () => {
  it("supports English, Traditional Chinese and Japanese, defaulting to English", () => {
    expect([...languages]).toEqual(["en", "zh-TW", "ja"]);
    expect(defaultLanguage).toBe("en");
    expect(Object.keys(languageDisplayNames).sort()).toEqual([...languages].sort());
  });

  it("recognizes only supported languages", () => {
    expect(isLanguage("ja")).toBe(true);
    expect(isLanguage("zh-TW")).toBe(true);
    expect(isLanguage("fr")).toBe(false);
    expect(isLanguage("zh-CN")).toBe(false);
    expect(isLanguage(undefined)).toBe(false);
  });
});

describe("message catalogs", () => {
  for (const language of languages) {
    describe(language, () => {
      const catalog: Readonly<Record<string, string>> = catalogs[language];

      it("has exactly the keys English defines", () => {
        expect(Object.keys(catalog).sort()).toEqual(Object.keys(en).sort());
      });

      it("has no empty messages", () => {
        for (const [key, message] of Object.entries(catalog)) {
          expect(message.trim().length, key).toBeGreaterThan(0);
        }
      });

      it("uses the same {placeholders} as English for every message", () => {
        for (const [key, message] of Object.entries(en)) {
          expect(placeholders(catalog[key]!), key).toEqual(placeholders(message));
        }
      });
    });
  }

  it("actually translates: no non-English message is identical to the English one", () => {
    // Guards against a placeholder-only or copy-pasted entry slipping
    // through as "translated". Shared vocabulary that is genuinely the same
    // in every language would be listed here as an exception.
    const sameInEveryLanguage = new Set<string>([]);
    for (const [key, message] of Object.entries(en)) {
      if (sameInEveryLanguage.has(key)) continue;
      expect(zhTW[key as keyof typeof zhTW], `zh-TW ${key}`).not.toBe(message);
      expect(ja[key as keyof typeof ja], `ja ${key}`).not.toBe(message);
    }
  });
});

describe("translate", () => {
  it("returns the message for the language", () => {
    expect(translate("en", "panel.queue.title")).toBe("Queue");
    expect(translate("zh-TW", "panel.queue.title")).toBe("佇列");
    expect(translate("ja", "panel.queue.title")).toBe("キュー");
  });

  it("fills placeholders, numbers included, wherever they appear", () => {
    expect(translate("en", "panel.queue.summary", { count: 3, duration: "1m5s" })).toBe(
      "**3 in queue** (total 1m5s)",
    );
    expect(translate("ja", "panel.queue.summary", { count: 3, duration: "1m5s" })).toBe(
      "**キュー内 3 曲**（合計 1m5s）",
    );
  });

  it("fills a repeated placeholder everywhere and treats values literally", () => {
    // `$&` and friends have special meaning in String.replace replacement
    // strings — a song title or user mention must never trigger them.
    expect(translate("en", "panel.hint.join", { requesters: "$& $1 {count}" })).toBe(
      "Join a voice channel. $& $1 {count}",
    );
  });

  it("leaves a placeholder with no matching param untouched instead of throwing", () => {
    expect(translate("en", "panel.queue.summary", { count: 3 })).toBe("**3 in queue** (total {duration})");
    expect(translate("en", "panel.queue.summary")).toBe("**{count} in queue** (total {duration})");
  });

  it("binds a language with translator()", () => {
    const t = translator("zh-TW");
    expect(t("panel.request.searching")).toBe("搜尋中…");
    expect(t("panel.queue.footerCount", { count: 2 })).toBe("待播 2 首");
  });
});
