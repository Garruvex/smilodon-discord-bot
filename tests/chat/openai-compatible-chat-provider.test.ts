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
    const summary = await provider.summarizeChannelMessages("99999999999999999", [
      { id: "m1", authorId: "alice", authorDisplayName: "Alice", content: "hello there" },
    ]);

    expect(summary.facts).toEqual([{
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

// chat_completions is the default provider mode (CHATBOT_MODE/UTILITY_MODE
// both default to it — see environment.ts), so this capability existing
// here at all is load-bearing: without it, dedicated personal-memory
// extraction silently never runs for anyone on default configuration.
describe("OpenAiCompatibleChatProvider — extractPersonalMemories", () => {
  it("posts a chat_completions request with the personal-memory-extraction schema and returns the parsed actions", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.example.com/v1/chat/completions");
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.model).toBe("summary-model");
      expect(body.response_format).toMatchObject({
        type: "json_schema",
        json_schema: { name: "personal_memory_extraction", strict: true },
      });
      const messages = body.messages as { role: string; content: string }[];
      expect(messages[0]!.content).toContain("I like green apples");
      expect(messages[0]!.content).toContain("Noted!");
      // Never asks the model to choose a subject — see
      // PersonalMemoryExtractionAction, which has no subjectUserId field.
      expect(JSON.stringify((body.response_format as { json_schema: { schema: unknown } }).json_schema.schema))
        .not.toContain("subjectUserId");
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              actions: [{ action: "upsert", aboutSpeaker: true, sourceQuote: "I like green apples", topic: "preference", slot: "food.fruit", statement: "likes green apples" }],
            }),
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleChatProvider(
      "https://api.example.com/v1", "secret", ["main-model"], ["summary-model"],
    );
    const actions = await provider.extractPersonalMemories(
      "I like green apples", "Noted!", { id: "user-1", displayName: "Red" },
    );

    expect(actions).toEqual([{ action: "upsert", aboutSpeaker: true, sourceQuote: "I like green apples", topic: "preference", slot: "food.fruit", statement: "likes green apples" }]);
  });

  it("throws a ChatProviderError when the model's output fails schema validation", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ actions: "nope" }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }))));

    const provider = new OpenAiCompatibleChatProvider(
      "https://api.example.com/v1", "secret", ["main-model"], null,
    );

    await expect(provider.extractPersonalMemories("hi", "hello", { id: "user-1", displayName: "Red" }))
      .rejects.toThrow("did not match the expected schema");
  });

  it("falls back to the next configured model when the first returns malformed output", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse((init!.body as string)) as { model: string };
      if (body.model === "model-a") {
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: "not json" } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              actions: [{ action: "upsert", aboutSpeaker: true, sourceQuote: "I like green apples", topic: "preference", slot: "food.fruit", statement: "likes green apples" }],
            }),
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleChatProvider(
      "https://api.example.com/v1", "secret", ["main-model"], ["model-a", "model-b"],
    );
    const actions = await provider.extractPersonalMemories("I like green apples", "Noted!", { id: "user-1", displayName: "Red" });

    expect(actions).toEqual([{ action: "upsert", aboutSpeaker: true, sourceQuote: "I like green apples", topic: "preference", slot: "food.fruit", statement: "likes green apples" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
