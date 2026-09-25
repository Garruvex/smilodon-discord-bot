import { describe, expect, it, vi } from "vitest";

import { ReactionArmBehavior, reactionReplyWindowMs } from "../../src/infrastructure/discord/behaviors/reaction-arm-behavior.js";
import type { MessageReactionWatchStore } from "../../src/application/chat/message-reaction-watch.js";
import type { ReactionAddedContext } from "../../src/application/behaviors/behavior.js";

function context(overrides: { userId?: string; userBot?: boolean; messageId?: string; guildId?: string } = {}): ReactionAddedContext {
  return {
    reaction: { message: { id: overrides.messageId ?? "m1", guildId: overrides.guildId ?? "g1" } } as never,
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

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never;

// No guild profile: the window falls back to the default wait.
const noProfiles = { find: (): null => null };

function profilesWithWait(min: number, max: number): { find: () => unknown } {
  return { find: (): unknown => ({ chat: { reactionReplyWaitMinMinutes: min, reactionReplyWaitMaxMinutes: max } }) };
}

describe("ReactionArmBehavior", () => {
  it("matches a real member's reaction", async () => {
    const behavior = new ReactionArmBehavior(() => "bot-id", fakeStore(), noProfiles, logger);
    await expect(behavior.matches(context({ userId: "human-1" }))).resolves.toBe(true);
  });

  it("ignores a reaction from another bot, and from the bot's own reaction", async () => {
    const behavior = new ReactionArmBehavior(() => "bot-id", fakeStore(), noProfiles, logger);
    await expect(behavior.matches(context({ userBot: true }))).resolves.toBe(false);
    await expect(behavior.matches(context({ userId: "bot-id" }))).resolves.toBe(false);
  });

  it("arms the watch for the reacted-to message on execute", async () => {
    const armOnFirstReaction = vi.fn(() => Promise.resolve(true));
    const behavior = new ReactionArmBehavior(() => "bot-id", fakeStore({ armOnFirstReaction }), noProfiles, logger);

    await behavior.execute(context({ messageId: "m42" }));

    expect(armOnFirstReaction).toHaveBeenCalledWith("m42", expect.any(Number), expect.any(Number));
  });

  it("arms with a wait inside the guild's configured range", async () => {
    const armOnFirstReaction = vi.fn((_id: string, _now: number, _windowMs: number) => Promise.resolve(true));
    const behavior = new ReactionArmBehavior(
      () => "bot-id", fakeStore({ armOnFirstReaction }), profilesWithWait(3, 4) as never, logger,
    );

    await behavior.execute(context({ messageId: "m42" }));

    const windowMs = armOnFirstReaction.mock.calls[0]?.[2] ?? 0;
    expect(windowMs).toBeGreaterThanOrEqual(3 * 60_000);
    expect(windowMs).toBeLessThanOrEqual(4 * 60_000);
  });
});

describe("reactionReplyWindowMs", () => {
  it("spans the configured range from its low end to its high end", () => {
    expect(reactionReplyWindowMs(profilesWithWait(2, 5) as never, "g1", () => 0)).toBe(2 * 60_000);
    expect(reactionReplyWindowMs(profilesWithWait(2, 5) as never, "g1", () => 1)).toBe(5 * 60_000);
  });

  it("falls back to the default 2-5 minute range without a guild profile", () => {
    expect(reactionReplyWindowMs(noProfiles, "g1", () => 0)).toBe(2 * 60_000);
    expect(reactionReplyWindowMs(noProfiles, null, () => 1)).toBe(5 * 60_000);
  });

  it("tolerates a reversed range from a hand-edited config", () => {
    expect(reactionReplyWindowMs(profilesWithWait(5, 2) as never, "g1", () => 0)).toBe(2 * 60_000);
  });

  it("logs and continues instead of throwing when the store call fails", async () => {
    const behavior = new ReactionArmBehavior(
      () => "bot-id",
      fakeStore({ armOnFirstReaction: () => Promise.reject(new Error("db down")) }),
      noProfiles,
      logger,
    );
    await expect(behavior.execute(context())).resolves.toBeDefined();
  });
});
