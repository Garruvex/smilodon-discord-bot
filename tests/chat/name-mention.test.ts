import { describe, expect, it } from "vitest";

import { containsBotName } from "../../src/domain/chat/name-mention.js";

describe("containsBotName", () => {
  it("matches a case-insensitive whole-word occurrence", () => {
    expect(containsBotName("yohta is so annoying", "Yohta")).toBe(true);
    expect(containsBotName("YOHTA!!", "Yohta")).toBe(true);
  });

  it("does not match a substring inside a longer word", () => {
    expect(containsBotName("yohtabot is cool", "Yohta")).toBe(false);
    expect(containsBotName("payohta", "Yohta")).toBe(false);
  });

  it("matches a multi-word display name as a phrase", () => {
    expect(containsBotName("have you tried FNTU Bot yet?", "FNTU Bot")).toBe(true);
    expect(containsBotName("FNTU is great", "FNTU Bot")).toBe(false);
  });

  it("returns false for an empty or blank display name", () => {
    expect(containsBotName("hello", "")).toBe(false);
    expect(containsBotName("hello", "   ")).toBe(false);
  });

  it("returns false when the name does not appear at all", () => {
    expect(containsBotName("good morning everyone", "Yohta")).toBe(false);
  });

  it("matches a CJK display name flanked by other CJK characters", () => {
    expect(containsBotName("最近松果都沒來", "松果")).toBe(true);
    expect(containsBotName("松果，在嗎", "松果")).toBe(true);
    expect(containsBotName("我覺得松果很可愛", "松果")).toBe(true);
  });

  it("returns false when a CJK display name does not appear at all", () => {
    expect(containsBotName("今天天氣真好", "松果")).toBe(false);
  });
});
