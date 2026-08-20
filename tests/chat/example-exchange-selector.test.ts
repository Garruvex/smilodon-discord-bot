import { describe, expect, it } from "vitest";

import { RelevantExampleExchangeSelector } from "../../src/application/chat/example-exchange-selector.js";
import type { ExampleExchange } from "../../src/application/chat/example-exchange.js";

function exchange(overrides: Partial<ExampleExchange> = {}): ExampleExchange {
  return { tags: "", user: "placeholder", character: "placeholder", ...overrides };
}

describe("RelevantExampleExchangeSelector", () => {
  it("ranks a lexically-matching Chinese example above an unrelated one", async () => {
    const examTalk = exchange({
      tags: "考試, 學校",
      user: "我今天期中考炸了",
      character: "草ww 哪科啦",
    });
    const unrelated = exchange({
      tags: "音樂, 推薦",
      user: "推薦一首歌",
      character: "聽聽這首吧",
    });
    const selector = new RelevantExampleExchangeSelector();

    const selected = await selector.select({
      records: [unrelated, examTalk],
      currentUser: { id: "user", displayName: "User", roleNames: [] },
      mentionedUsers: [],
      recentHistory: [],
      message: "期中考 炸了",
      now: 1_000,
    });

    expect(selected[0]).toEqual(examTalk);
  });

  it("ranks a lexically-matching example above an unrelated one", async () => {
    const examTalk = exchange({
      tags: "exam school venting",
      user: "my midterm exam went badly today",
      character: "lol rip which subject",
    });
    const unrelated = exchange({
      tags: "music recommendation",
      user: "recommend me a song",
      character: "listen to this one",
    });
    const selector = new RelevantExampleExchangeSelector();

    const selected = await selector.select({
      records: [unrelated, examTalk],
      currentUser: { id: "user", displayName: "User", roleNames: [] },
      mentionedUsers: [],
      recentHistory: [],
      message: "my exam today was a disaster",
      now: 1_000,
    });

    expect(selected[0]).toEqual(examTalk);
  });

  it("returns an empty array without erroring when there are no examples", async () => {
    const selector = new RelevantExampleExchangeSelector();

    const selected = await selector.select({
      records: [],
      currentUser: { id: "user", displayName: "User", roleNames: [] },
      mentionedUsers: [],
      recentHistory: [],
      message: "anything",
      now: 1_000,
    });

    expect(selected).toHaveLength(0);
  });

  it("keeps as many examples as fit under the serialized char budget", async () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      exchange({ tags: `topic${i}`, user: `message ${i}`, character: `reply ${i}` }));
    const selector = new RelevantExampleExchangeSelector();

    const selected = await selector.select({
      records: many,
      currentUser: { id: "user", displayName: "User", roleNames: [] },
      mentionedUsers: [],
      recentHistory: [],
      message: "message",
      now: 1_000,
    });

    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThanOrEqual(many.length);
  });
});
