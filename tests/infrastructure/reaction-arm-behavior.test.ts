import { describe, expect, it, vi } from "vitest";

import { ReactionArmBehavior } from "../../src/infrastructure/discord/behaviors/reaction-arm-behavior.js";
import type { MessageReactionWatchStore } from "../../src/application/chat/message-reaction-watch.js";
import type { ReactionAddedContext } from "../../src/application/behaviors/behavior.js";

function context(overrides: { userId?: string; userBot?: boolean; messageId?: string } = {}): ReactionAddedContext {
  return {
    reaction: { message: { id: overrides.messageId ?? "m1" } } as never,
    user: { id: overrides.userId ?? "human-1", bot: overrides.userBot ?? false } as never,
  };
}

function fakeStore(overrides: Partial<MessageReactionWatchStore> = {}): MessageReactionWatchStore {
  return {
    initialize: () => Promise.resolve(),
    register: () => Promise.resolve(),
    armOnFirstReaction: () => Promise.resolve(true),
    dequeueDue: () => Promise.resolve([]),
    markDone: () => Promise.resolve(),
    deleteOlderThan: () => Promise.resolve(0),
    ...overrides,
  };
}

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never;

describe("ReactionArmBehavior", () => {
  it("matches a real member's reaction", async () => {
    const behavior = new ReactionArmBehavior(() => "bot-id", fakeStore(), logger);
    await expect(behavior.matches(context({ userId: "human-1" }))).resolves.toBe(true);
  });

  it("ignores a reaction from another bot, and from the bot's own reaction", async () => {
    const behavior = new ReactionArmBehavior(() => "bot-id", fakeStore(), logger);
    await expect(behavior.matches(context({ userBot: true }))).resolves.toBe(false);
    await expect(behavior.matches(context({ userId: "bot-id" }))).resolves.toBe(false);
  });

  it("arms the watch for the reacted-to message on execute", async () => {
    const armOnFirstReaction = vi.fn(() => Promise.resolve(true));
    const behavior = new ReactionArmBehavior(() => "bot-id", fakeStore({ armOnFirstReaction }), logger);

    await behavior.execute(context({ messageId: "m42" }));

    expect(armOnFirstReaction).toHaveBeenCalledWith("m42", expect.any(Number), expect.any(Number));
  });

  it("logs and continues instead of throwing when the store call fails", async () => {
    const behavior = new ReactionArmBehavior(
      () => "bot-id",
      fakeStore({ armOnFirstReaction: () => Promise.reject(new Error("db down")) }),
      logger,
    );
    await expect(behavior.execute(context())).resolves.toBeDefined();
  });
});
