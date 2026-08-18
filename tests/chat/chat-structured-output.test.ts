import { describe, expect, it } from "vitest";

import { ChatProviderError } from "../../src/application/chat/chat-provider.js";
import { parseChatModelOutput } from "../../src/infrastructure/chat/chat-structured-output.js";

describe("parseChatModelOutput", () => {
  it("parses a well-formed structured reply", () => {
    const output = parseChatModelOutput(JSON.stringify({
      response: "Hello there.",
      userMemoryActions: [],
      guildKnowledgeCandidates: [],
    }));

    expect(output.response).toBe("Hello there.");
    expect(output.userMemoryActions).toEqual([]);
    expect(output.guildKnowledgeCandidates).toEqual([]);
  });

  it("throws a ChatProviderError instead of returning raw text for invalid JSON", () => {
    expect(() => parseChatModelOutput("not json at all")).toThrow(ChatProviderError);
  });

  it("throws a ChatProviderError for JSON that does not match the schema", () => {
    expect(() => parseChatModelOutput(JSON.stringify({ unexpected: true }))).toThrow(ChatProviderError);
  });
});
