import { describe, expect, it } from "vitest";

import { decodeDraft, emptyDraft, encodeDraft, libraryCustomId, parseLibraryId, scoresOf, type Draft } from "../../../../src/infrastructure/discord/campaign/library-ids.js";

describe("library custom IDs", () => {
  it("parses only the library's own IDs", () => {
    expect(parseLibraryId(libraryCustomId("view", "lc-abc"))).toEqual({ action: "view", parts: ["lc-abc"] });
    expect(parseLibraryId("dnd:join:c1")).toBeNull();
    expect(parseLibraryId("dndchar:nonsense")).toBeNull();
  });

  it("keeps the builder's choices in a short token that round-trips", () => {
    const draft: Draft = { class: "rogue", race: "half-elf", kit: "duelist", skills: ["stealth", "perception", "acrobatics", "deception"], expertise: ["stealth", "perception"], order: ["dex", "cha", "int", "con", "wis"] };
    const token = encodeDraft(draft);
    expect(token.length).toBeLessThan(30);
    expect(decodeDraft(token)).toEqual(draft);
    // The longest token still fits in a custom ID with its longest prefix.
    expect(libraryCustomId("bScore", token).length).toBeLessThan(100);
    expect(decodeDraft(encodeDraft(emptyDraft))).toEqual(emptyDraft);
  });

  it("reads a tampered token as far as it is legal and no further", () => {
    expect(decodeDraft(undefined)).toEqual(emptyDraft);
    expect(decodeDraft("x9.zzz..")).toEqual(emptyDraft);
    // An unknown kit drops everything that depended on it.
    expect(decodeDraft("f9.ac..dc")).toMatchObject({ class: "fighter", race: null, kit: null, skills: [], order: ["dex", "con"] });
    // A skill the class cannot take is ignored, and so is a repeat.
    const fighter: Draft = { class: "fighter", race: "human", kit: "knight", skills: ["stealth", "athletics", "athletics"], expertise: [], order: [] };
    expect(decodeDraft(encodeDraft(fighter)).skills).toEqual(["athletics"]);
    // Expertise only in skills the hero has, abilities only once each.
    const rogue: Draft = { class: "rogue", race: "elf", kit: "shadow", skills: ["stealth"], expertise: ["perception"], order: ["dex", "dex", "dex"] };
    expect(decodeDraft(encodeDraft(rogue)).expertise).toEqual([]);
    expect(decodeDraft(encodeDraft(rogue)).order).toEqual(["dex"]);
  });

  it("deals the standard array in the order chosen, and gives the last ability the last value", () => {
    expect(scoresOf(["dex", "cha"])).toEqual({ dex: 15, cha: 14 });
    expect(scoresOf(["dex", "cha", "int", "con", "wis"])).toEqual({ dex: 15, cha: 14, int: 13, con: 12, wis: 10, str: 8 });
    expect(scoresOf([])).toEqual({});
  });
});
