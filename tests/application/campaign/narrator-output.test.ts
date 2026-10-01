import { describe, expect, it } from "vitest";

import { parseNarratorOutput, restoreLineBreaks } from "../../../src/application/campaign/dm/llm-dm.js";

describe("the Narrator's line breaks", () => {
  it("turns a written-out backslash n into a real line break", () => {
    expect(restoreLineBreaks("First beat.\\n\\nSecond beat.")).toBe("First beat.\n\nSecond beat.");
    expect(restoreLineBreaks("A\\r\\nB")).toBe("A\nB");
  });

  it("leaves real line breaks and ordinary text alone", () => {
    expect(restoreLineBreaks("One.\n\nTwo.")).toBe("One.\n\nTwo.");
    expect(restoreLineBreaks("  plain  ")).toBe("plain");
  });

  it("applies to what the model returns", () => {
    expect(parseNarratorOutput(JSON.stringify({ narration: "Door opens.\\n\\nThey step in." }))).toBe("Door opens.\n\nThey step in.");
  });
});
