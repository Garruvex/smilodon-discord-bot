import { describe, expect, it } from "vitest";

import { ChatProviderError } from "../../src/application/chat/chat-provider.js";
import {
  buildAttributionVerificationPrompt,
  parseAttributionVerificationOutput,
} from "../../src/application/chat/attribution-verification.js";

describe("buildAttributionVerificationPrompt", () => {
  it("fences both DRAFT and CONTEXT as untrusted, and tags each context line with its real id", () => {
    const prompt = buildAttributionVerificationPrompt(
      "LW only said \"friend has grey fur\" so far.",
      [
        { authorId: "ginco", authorDisplayName: "Ginco", content: "friend has grey fur" },
        { authorId: "lw", authorDisplayName: "LW", content: "hello" },
      ],
    );
    expect(prompt).toContain("<<<BEGIN-UNTRUSTED-DATA>>>\nLW only said \"friend has grey fur\" so far.\n<<<END-UNTRUSTED-DATA>>>");
    expect(prompt).toContain("1. Ginco (ginco): friend has grey fur");
    expect(prompt).toContain("2. LW (lw): hello");
  });

  it("renders 'none' for empty context", () => {
    const prompt = buildAttributionVerificationPrompt("draft text", []);
    expect(prompt).toContain("<<<BEGIN-UNTRUSTED-DATA>>>\nnone\n<<<END-UNTRUSTED-DATA>>>");
  });
});

describe("parseAttributionVerificationOutput", () => {
  it("parses a well-formed no-correction response", () => {
    const result = parseAttributionVerificationOutput(JSON.stringify({
      needsCorrection: false,
      correctedResponse: null,
    }));
    expect(result).toEqual({ needsCorrection: false, correctedResponse: null });
  });

  it("parses a well-formed corrected response", () => {
    const result = parseAttributionVerificationOutput(JSON.stringify({
      needsCorrection: true,
      correctedResponse: "Ginco said that, not LW.",
    }));
    expect(result).toEqual({ needsCorrection: true, correctedResponse: "Ginco said that, not LW." });
  });

  it("throws a ChatProviderError instead of returning raw text for invalid JSON", () => {
    expect(() => parseAttributionVerificationOutput("not json")).toThrow(ChatProviderError);
  });

  it("throws a ChatProviderError for JSON that does not match the schema", () => {
    expect(() => parseAttributionVerificationOutput(JSON.stringify({ unexpected: true }))).toThrow(ChatProviderError);
  });
});
