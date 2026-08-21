import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAiCompatibleChatProvider } from "../../src/infrastructure/chat/openai-compatible-chat-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAiCompatibleChatProvider — summarizeChannelMessages", () => {
  it("posts a chat_completions request with the channel-summary schema and returns the parsed facts", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.example.com/v1/chat/completions");
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.model).toBe("summary-model");
      expect(body.response_format).toMatchObject({
        type: "json_schema",
        json_schema: { name: "channel_message_summary", strict: true },
      });
      const messages = body.messages as { role: string; content: string }[];
      expect(messages[0]!.content).toContain("a1=alice (Alice)");
      expect(messages[0]!.content).not.toContain("99999999999999999");
      expect(messages[0]!.content).toContain("hello there");
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              facts: [{
                subjectType: "member", subjectId: "a1", topic: "community_activity",
                slot: "raid.friday", statement: "organizes raids", evidenceMessageIds: ["m1"],
              }],
            }),
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleChatProvider(
      "https://api.example.com/v1", "secret", ["main-model"], ["summary-model"],
    );
    const facts = await provider.summarizeChannelMessages("99999999999999999", [
      { id: "m1", authorId: "alice", authorDisplayName: "Alice", content: "hello there" },
    ]);

    expect(facts).toEqual([{
      subjectType: "member", subjectId: "alice", topic: "community_activity",
      slot: "raid.friday", statement: "organizes raids", evidenceMessageIds: ["m1"],
    }]);
  });

  it("throws a ChatProviderError when the model's output fails schema validation", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ facts: [{ subjectType: "member" }] }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }))));

    const provider = new OpenAiCompatibleChatProvider(
      "https://api.example.com/v1", "secret", ["main-model"], null,
    );

    await expect(provider.summarizeChannelMessages("99999999999999999", [
      { id: "m1", authorId: "alice", authorDisplayName: "Alice", content: "hello there" },
    ])).rejects.toThrow("did not match the expected schema");
  });
});
