import { describe, expect, it } from "vitest";
import { instrumentModel, modelGenerationHealth } from "../../src/application/diagnostics/model-diagnostics.js";
import { withDiagnosticScope } from "../../src/application/diagnostics/chat-diagnostics.js";
import { ChatProviderError } from "../../src/application/chat/chat-provider.js";
import { ModelFallbackChain } from "../../src/infrastructure/chat/model-fallback-chain.js";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";

describe("model diagnostics", () => {
  it("keeps generation health separate from decision/utility calls", async () => {
    const { logger } = captureDiagnosticLogger();
    const provider = instrumentModel({ reply: () => Promise.resolve("answer"), generateCharacterData: () => Promise.reject(new Error("decision down")) }, logger);
    await provider.reply(); await expect(provider.generateCharacterData()).rejects.toThrow();
    expect(modelGenerationHealth(logger)).toMatchObject({ completed: 1, failed: 0, lastFailureAt: null });
  });
  it("retains failed primary attempts, successful fallback and cooldown without content", async () => {
    const { logger, records } = captureDiagnosticLogger();
    const chain = new ModelFallbackChain(["secret-model-a", "secret-model-b"]);
    class Provider {
      #response = "SECRET_RESPONSE";
      public reply(_prompt: string): Promise<string> {
        return chain.run((model) => model === "secret-model-a" ? Promise.reject(new ChatProviderError("SECRET_ERROR", 429, null)) : Promise.resolve(this.#response));
      }
    }
    const provider = instrumentModel(new Provider(), logger);
    // The wrapper deliberately binds this method and caches its identity.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(provider.reply).toBe(provider.reply);
    await withDiagnosticScope({ operation: "chat_turn", guildId: "guild", channelId: "channel", sourceMessageId: "source" }, async () => {
      expect(await provider.reply("SECRET_PROMPT")).toBe("SECRET_RESPONSE");
      await provider.reply("SECRET_PROMPT");
    });
    expect(records.filter((record) => record.event === "model.provider.attempt").map((record) => record.status)).toEqual(["failed", "completed", "cooldown", "completed"]);
    expect(records[0]).toMatchObject({ failure: "rate_limited", httpStatus: 429, modelIndex: 0 });
    expect(new Set(records.map((record) => record.traceId)).size).toBe(1);
    expect(JSON.stringify(records)).not.toMatch(/SECRET|secret-model/u);
  });
  it("records stream retry separately and does not invent missing capabilities", async () => {
    const { logger, records } = captureDiagnosticLogger();
    const chain = new ModelFallbackChain(["model"]);
    let calls = 0;
    const provider = instrumentModel({ reply: () => chain.run(() => ++calls === 1
      ? Promise.reject(new ChatProviderError("SECRET", 502, "incomplete_stream")) : Promise.resolve("ok")) }, logger);
    expect("generateReferenceImage" in provider).toBe(false);
    await expect(provider.reply()).resolves.toBe("ok");
    expect(records.filter((record) => record.event === "model.provider.attempt").map((record) => record.attempt)).toEqual([1, 2]);
  });
  it("distinguishes rejected operations from failure returned as a value", async () => {
    const { logger, records } = captureDiagnosticLogger();
    const error = new Error("SECRET");
    const provider = instrumentModel({ embed: () => Promise.reject(error), generateReferenceImage: () => Promise.resolve({ ok: false, reason: "SECRET" }) }, logger);
    await expect(provider.embed()).rejects.toBe(error);
    await provider.generateReferenceImage();
    expect(records.map((record) => record.status)).toEqual(["failed", "reported_failure"]);
    expect(JSON.stringify(records)).not.toContain("SECRET");
  });
  it("keeps concurrent background calls isolated", async () => {
    const { logger, records } = captureDiagnosticLogger();
    const provider = instrumentModel({ summarizeChannelMessages: () => Promise.resolve("SECRET") }, logger);
    await Promise.all([provider.summarizeChannelMessages(), provider.summarizeChannelMessages()]);
    expect(new Set(records.map((record) => record.traceId)).size).toBe(2);
    expect(records.every((record) => record.purpose === "summarizeChannelMessages")).toBe(true);
  });
});
