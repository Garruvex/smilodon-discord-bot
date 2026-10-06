import { describe, expect, it } from "vitest";

import { parseNarratorOutput, parseRoundNarratorOutput, restoreLineBreaks } from "../../../src/application/campaign/dm/llm-dm.js";

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

  it("repairs a reply with a raw line break, an unescaped quote or a code fence", () => {
    const raw = '{"narration":"The scarecrow stays silent.\n\nOnyx says "who are you" again.","note":""}';
    expect(parseRoundNarratorOutput(raw)).toEqual({ narration: 'The scarecrow stays silent.\n\nOnyx says "who are you" again.', note: "" });
    expect(parseNarratorOutput("```json\n" + JSON.stringify({ narration: "Fenced." }) + "\n```")).toBe("Fenced.");
  });

  it("still refuses a reply that is not JSON at all, and logs it whole", () => {
    expect(() => parseNarratorOutput("The door opens.")).toThrow(/reply "The door opens\./);
  });
});
