import { describe, expect, it } from "vitest";

import { defaultLanguage, isLanguage, languageDisplayNames, languages } from "../../src/application/i18n/language.js";
import { en } from "../../src/application/i18n/messages/en.js";
import {
  buildTexts,
  CatalogError,
  catalogIssues,
  texts,
  untranslatedKeys,
  type Texts,
} from "../../src/application/i18n/texts.js";

// Walks a built text object back into "dotted.key" -> string | function.
function flatten(node: unknown, prefix = ""): Map<string, unknown> {
  const entries = new Map<string, unknown>();
  for (const [segment, value] of Object.entries(node as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${segment}` : segment;
    if (value && typeof value === "object") {
      for (const [childKey, childValue] of flatten(value, key)) entries.set(childKey, childValue);
    } else {
      entries.set(key, value);
    }
  }
  return entries;
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
    expect(isLanguage(undefined)).toBe(false);
  });
});

describe("the bot's catalogs", () => {
  it("have no catalog errors (unknown keys, blank or mis-placeholdered translations)", () => {
    expect(catalogIssues).toEqual([]);
  });

  it("give every language exactly the shape English defines", () => {
    const english = flatten(texts.en);
    expect([...english.keys()].sort()).toEqual(Object.keys(en).sort());
    for (const language of languages) {
      const shape = [...flatten(texts[language])].map(([key, value]) => [key, typeof value]);
      expect(shape, language).toEqual([...english].map(([key, value]) => [key, typeof value]));
    }
  });

  it("make static messages strings and placeholder messages functions", () => {
    expect(typeof texts.ja.music.panel.queue.title).toBe("string");
    expect(typeof texts.ja.music.panel.queue.footerCount).toBe("function");
    expect(texts.en.music.panel.queue.summary({ count: 3, duration: "1m5s" })).toBe("**3 in queue** (total 1m5s)");
    expect(texts.ja.music.panel.queue.summary({ count: 3, duration: "1m5s" })).toBe("**キュー内 3 曲**（合計 1m5s）");
    expect(texts["zh-TW"].music.label.repeat.queue).toBe("待播清單");
  });

  it("are frozen, so no caller can change another server's text", () => {
    expect(Object.isFrozen(texts.ja)).toBe(true);
    expect(Object.isFrozen(texts.ja.music.panel.queue)).toBe(true);
    expect(() => {
      (texts.ja.music.panel.queue as { title: string }).title = "changed";
    }).toThrow(TypeError);
  });

  it("report untranslated keys per language (English has none)", () => {
    expect(untranslatedKeys.en).toEqual([]);
    for (const language of languages) {
      for (const key of untranslatedKeys[language]) expect(Object.keys(en), language).toContain(key);
    }
  });
});

describe("buildTexts", () => {
  const english = {
    "greeting.hello": "Hello",
    "greeting.welcome": "Welcome, {name}!",
    "queue.moved": "Moved {title} to {position}.",
  };

  it("falls back to English for a missing translation, and reports it as untranslated", () => {
    const built = buildTexts(english, { xx: { "greeting.hello": "Hallo" } });
    const text = built.texts.xx as { greeting: { hello: string; welcome: (p: object) => string } };

    expect(text.greeting.hello).toBe("Hallo");
    expect(text.greeting.welcome({ name: "Red" })).toBe("Welcome, Red!");
    expect(built.untranslated.xx).toEqual(["greeting.welcome", "queue.moved"]);
    expect(built.issues).toEqual([]);
  });

  it("lets a translation reorder and repeat placeholders", () => {
    const built = buildTexts(english, {
      xx: { "queue.moved": "{position} ← {title} ({title})" },
    });
    const text = built.texts.xx as { queue: { moved: (p: object) => string } };

    expect(text.queue.moved({ title: "Song", position: 2 })).toBe("2 ← Song (Song)");
    expect(built.issues).toEqual([]);
  });

  it("inserts values literally — no replacement syntax, no second pass", () => {
    const built = buildTexts(english, { xx: {} });
    const text = built.texts.xx as { greeting: { welcome: (p: object) => string } };

    expect(text.greeting.welcome({ name: "$& $1 $$ {name} {title}" })).toBe("Welcome, $& $1 $$ {name} {title}!");
  });

  it("leaves a placeholder with no value visible instead of throwing", () => {
    const built = buildTexts(english, { xx: {} });
    const text = built.texts.xx as { queue: { moved: (p: object) => string } };

    expect(text.queue.moved({ title: "Song" })).toBe("Moved Song to {position}.");
  });

  it("reports a blank translation and uses English", () => {
    const built = buildTexts(english, { xx: { "greeting.hello": "   " } });

    expect((built.texts.xx as { greeting: { hello: string } }).greeting.hello).toBe("Hello");
    expect(built.issues).toEqual([{ language: "xx", key: "greeting.hello", problem: "is blank" }]);
  });

  it("reports a translation with different placeholders and uses English", () => {
    const built = buildTexts(english, { xx: { "greeting.welcome": "Willkommen, {nom}!" } });
    const text = built.texts.xx as { greeting: { welcome: (p: object) => string } };

    expect(text.greeting.welcome({ name: "Red" })).toBe("Welcome, Red!");
    expect(built.issues).toHaveLength(1);
    expect(built.issues[0]).toMatchObject({ language: "xx", key: "greeting.welcome" });
    expect(built.issues[0]!.problem).toContain("{nom}");
  });

  it("reports a stray brace in a translation and uses English", () => {
    const built = buildTexts(english, { xx: { "greeting.hello": "Hallo {" } });

    expect((built.texts.xx as { greeting: { hello: string } }).greeting.hello).toBe("Hello");
    expect(built.issues[0]!.problem).toContain("isn't a `{name}` placeholder");
  });

  it("reports a translated key English doesn't have", () => {
    const built = buildTexts(english, { xx: { "greeting.bye": "Tschüss" } });

    expect(built.issues).toEqual([{ language: "xx", key: "greeting.bye", problem: "is not an English message key" }]);
    expect(Object.keys((built.texts.xx as { greeting: object }).greeting)).not.toContain("bye");
  });

  it("rejects an English key that is both a message and a group", () => {
    expect(() => buildTexts({ "a.b": "x", "a.b.c": "y" }, {})).toThrow(CatalogError);
    expect(() => buildTexts({ "a.b": "x", "a.b.c": "y" }, {})).toThrow(/"a\.b" is a message but "a\.b\.c"/);
  });

  it("rejects empty, reserved and invalid English key segments", () => {
    expect(() => buildTexts({ "a..b": "x" }, {})).toThrow(/empty path segment/);
    expect(() => buildTexts({ "a.__proto__.b": "x" }, {})).toThrow(/reserved name "__proto__"/);
    expect(() => buildTexts({ "a.constructor": "x" }, {})).toThrow(/reserved name "constructor"/);
    expect(() => buildTexts({ "a.b-c": "x" }, {})).toThrow(/invalid path segment "b-c"/);
  });

  it("rejects a blank or malformed English message", () => {
    expect(() => buildTexts({ "a.b": "" }, {})).toThrow(/is blank/);
    expect(() => buildTexts({ "a.b": "Hi {name" }, {})).toThrow(/isn't a `\{name\}` placeholder/);
  });
});

// Compile-time guarantees: each @ts-expect-error below must stay an error, or
// `tsc` (which covers tests/) fails with "unused @ts-expect-error".
describe("Texts type", () => {
  it("rejects wrong paths, missing values, and calls on static text", () => {
    const text: Texts = texts.en;
    const checks = (): string => {
      // @ts-expect-error — a typo in the path
      void text.music.panel.queue.titel;
      // @ts-expect-error — a placeholder value is missing
      void text.music.panel.queue.summary({ count: 1 });
      // @ts-expect-error — a static message is not a function
      void text.music.panel.queue.title();
      // @ts-expect-error — a placeholder message must be called
      const notCalled: string = text.music.panel.queue.footerCount;
      // @ts-expect-error — text is read-only
      text.music.panel.queue.title = "x";
      return notCalled;
    };
    expect(typeof checks).toBe("function");
  });
});
