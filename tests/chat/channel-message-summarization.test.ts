import { describe, expect, it } from "vitest";

import { prepareChannelMessageSummary } from "../../src/infrastructure/chat/channel-message-summarization.js";

describe("prepareChannelMessageSummary", () => {
  it("uses compact aliases and resolves them locally after extraction", () => {
    const prepared = prepareChannelMessageSummary("guild-123", [
      { id: "message-1", authorId: "author-1", authorDisplayName: "Fox", content: "I run Friday raids." },
      { id: "message-2", authorId: "author-1", authorDisplayName: "Fox", content: "They start at eight." },
    ]);

    expect(prepared.prompt).toContain("a1=author-1 (Fox)");
    expect(prepared.prompt).toContain("[m1][a1] I run Friday raids.");
    expect(prepared.prompt).toContain("[m2][a1] They start at eight.");
    expect(prepared.prompt.match(/author-1/g)).toHaveLength(1);

    expect(prepared.parse(JSON.stringify({ facts: [{
      subjectType: "member",
      subjectId: "a1",
      topic: "responsibility",
      slot: "friday_raids",
      statement: "Runs Friday raids.",
      evidenceMessageIds: ["m1", "m2"],
    }] }))).toEqual({ facts: [{
      subjectType: "member",
      subjectId: "author-1",
      topic: "responsibility",
      slot: "friday_raids",
      statement: "Runs Friday raids.",
      evidenceMessageIds: ["message-1", "message-2"],
    }] });
  });
});
