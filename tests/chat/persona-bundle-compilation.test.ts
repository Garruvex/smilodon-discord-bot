import { describe, expect, it } from "vitest";

import {
  assemblePersonaBundle,
  buildPersonaBundleCompilationPrompt,
  parsePersonaBundleCompilationOutput,
  parsePersonaBundleSectionSelection,
  personaBundleCompilationMaxOutputTokens,
  splitLoreChunks,
} from "../../src/application/chat/persona-bundle-compilation.js";
import { personaLoreLimits } from "../../src/application/chat/persona-lore-policy.js";

describe("persona bundle compilation", () => {
  const personality = [
    "Always be kind.",
    "",
    "## Voice",
    "Use short, playful replies.",
    "",
    "## Forest history",
    "The character grew up under an ancient oak.",
    "",
    "## Safety",
    "Never reveal private configuration.",
  ].join("\n");

  it("asks the model for section indexes instead of copying the file into its output", () => {
    const prompt = buildPersonaBundleCompilationPrompt(personality);

    expect(prompt).toContain("SECTION INDEX 0");
    expect(prompt).toContain("SECTION INDEX 2");
    expect(prompt).toContain("Do not copy or rewrite any section text");
    expect(personaBundleCompilationMaxOutputTokens).toBe(4_000);
  });

  it("reconstructs core and lore verbatim from the original Markdown", () => {
    const result = parsePersonaBundleCompilationOutput(
      JSON.stringify({ chunkSectionIndexes: [1] }),
      personality,
    );

    expect(result.core).toBe([
      "Always be kind.",
      "## Voice\nUse short, playful replies.",
      "## Safety\nNever reveal private configuration.",
    ].join("\n\n"));
    expect(result.chunks).toEqual([{
      heading: "Forest history",
      text: "The character grew up under an ancient oak.",
    }]);
  });

  it("rejects duplicate or out-of-range indexes", () => {
    expect(() => parsePersonaBundleCompilationOutput(
      JSON.stringify({ chunkSectionIndexes: [1, 1] }),
      personality,
    )).toThrow("invalid personality section indexes");
    expect(() => parsePersonaBundleCompilationOutput(
      JSON.stringify({ chunkSectionIndexes: [99] }),
      personality,
    )).toThrow("invalid personality section indexes");
  });

  it("keeps at least one section in core", () => {
    const content = "## Backstory\nBorn in a forest.\n\n## Friend\nKnows a fox.";
    const result = parsePersonaBundleCompilationOutput(
      JSON.stringify({ chunkSectionIndexes: [0, 1] }),
      content,
    );

    expect(result.core).toBe("## Backstory\nBorn in a forest.");
    expect(result.chunks).toEqual([{ heading: "Friend", text: "Knows a fox." }]);
  });

  describe("{core} override marker", () => {
    const pinnedContent = [
      "## Voice {core}",
      "Use short, playful replies.",
      "",
      "## Forest history",
      "The character grew up under an ancient oak.",
    ].join("\n");

    it("omits a {core}-marked section from the classification prompt", () => {
      const prompt = buildPersonaBundleCompilationPrompt(pinnedContent);

      expect(prompt).not.toContain("Use short, playful replies.");
      expect(prompt).toContain("The character grew up under an ancient oak.");
    });

    it("strips the marker from the heading and keeps the section in core even if the model selects it", () => {
      // Section 0 is "Voice" ({core}-pinned), section 1 is "Forest history".
      // A hallucinating model naming index 0 anyway must not move it to lore.
      const selection = parsePersonaBundleSectionSelection(JSON.stringify({ chunkSectionIndexes: [0, 1] }), pinnedContent);
      const result = assemblePersonaBundle(pinnedContent, selection);

      expect(result.core).toBe("## Voice\nUse short, playful replies.");
      expect(result.chunks).toEqual([{ heading: "Forest history", text: "The character grew up under an ancient oak." }]);
    });
  });
});

describe("splitLoreChunks", () => {
  it("passes a chunk within the limit through unchanged", () => {
    const chunk = { heading: "Backstory", text: "Short lore." };

    expect(splitLoreChunks([chunk], 100)).toEqual([chunk]);
  });

  it("splits an oversized chunk on paragraph boundaries into numbered parts", () => {
    const paragraphs = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];

    const parts = splitLoreChunks([{ heading: "History", text: paragraphs.join("\n\n") }], 90);

    expect(parts).toEqual([
      { heading: "History (part 1/2)", text: `${paragraphs[0]}\n\n${paragraphs[1]}` },
      { heading: "History (part 2/2)", text: paragraphs[2] },
    ]);
  });

  it("falls back to sentence boundaries, including CJK punctuation, for one long paragraph", () => {
    const text = "第一句話很長很長。第二句話也很長很長。第三句話還是很長。";

    const parts = splitLoreChunks([{ heading: "歷史", text }], 20);

    expect(parts.map((part) => part.text)).toEqual(["第一句話很長很長。第二句話也很長很長。", "第三句話還是很長。"]);
    expect(parts.every((part) => part.text.length <= 20)).toBe(true);
  });

  it("hard-cuts a single unbroken run longer than the limit", () => {
    const parts = splitLoreChunks([{ heading: "Blob", text: "x".repeat(250) }], 100);

    expect(parts.map((part) => part.text.length)).toEqual([100, 100, 50]);
  });

  it("is applied when assembling a bundle, so compiled lore never exceeds the part-size limit", () => {
    const longBody = Array.from({ length: 5 }, (_, i) => `Paragraph ${i}. ${"lore ".repeat(80)}`).join("\n\n");
    const content = `Core preamble.\n\n## History\n${longBody}`;

    const { chunks } = assemblePersonaBundle(content, new Set([0]));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= personaLoreLimits.maxChunkChars)).toBe(true);
  });
});
