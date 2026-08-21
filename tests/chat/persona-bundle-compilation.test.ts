import { describe, expect, it } from "vitest";

import {
  buildPersonaBundleCompilationPrompt,
  parsePersonaBundleCompilationOutput,
  personaBundleCompilationMaxOutputTokens,
} from "../../src/infrastructure/chat/persona-bundle-compilation.js";

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
});
