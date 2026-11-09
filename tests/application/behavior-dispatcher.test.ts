import type { Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { BehaviorDispatcher } from "../../src/application/behaviors/behavior-dispatcher.js";
import { BehaviorRegistry } from "../../src/application/behaviors/behavior-registry.js";
import { BehaviorEvent, BehaviorResult } from "../../src/application/behaviors/behavior.js";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";

const message = { id: "source", guildId: "guild", channelId: "channel", content: "SECRET_CONTENT" } as Message;

describe("behavior dispatch diagnostics", () => {
  it("records the earlier behavior that stops a message before mention chat", async () => {
    const registry = new BehaviorRegistry();
    const mention = vi.fn(() => Promise.resolve(BehaviorResult.Handled));
    registry.register({ id: "trap", event: BehaviorEvent.MessageCreated, priority: 200,
      matches: () => Promise.resolve(true), execute: () => Promise.resolve(BehaviorResult.StopPropagation) });
    registry.register({ id: "mention", event: BehaviorEvent.MessageCreated, priority: 100,
      matches: () => Promise.resolve(true), execute: mention });
    const { logger, records } = captureDiagnosticLogger();
    expect(await new BehaviorDispatcher(registry, logger).dispatch(BehaviorEvent.MessageCreated, message)).toBe(BehaviorResult.StopPropagation);
    expect(mention).not.toHaveBeenCalled();
    expect(records.at(-1)).toMatchObject({ event: "chat.dispatch.completed", behaviorId: "trap", stage: "execute", result: "stop_propagation", sourceMessageId: "source" });
    expect(new Set(records.map((record) => record.traceId)).size).toBe(1);
    expect(JSON.stringify(records)).not.toContain("SECRET");
  });

  it.each(["matches", "execute"] as const)("retains an error in %s and records one safe terminal event", async (stage) => {
    const registry = new BehaviorRegistry();
    const error = new Error("SECRET_FAILURE");
    registry.register({ id: "broken", event: BehaviorEvent.MessageCreated, priority: 1,
      matches: () => stage === "matches" ? Promise.reject(error) : Promise.resolve(true),
      execute: () => Promise.reject(error) });
    const { logger, records } = captureDiagnosticLogger();
    await expect(new BehaviorDispatcher(registry, logger).dispatch(BehaviorEvent.MessageCreated, message)).rejects.toBe(error);
    expect(records.filter((record) => record.event === "chat.dispatch.completed")).toEqual([
      expect.objectContaining({ result: "failed", stage, behaviorId: "broken", failure: "operation_error" }),
    ]);
    expect(JSON.stringify(records)).not.toContain("SECRET");
  });
});
