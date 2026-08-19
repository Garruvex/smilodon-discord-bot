import { describe, expect, it } from "vitest";

import { ChatProviderError } from "../../src/application/chat/chat-provider.js";
import { ChatModelFallbackExhaustedError, ModelFallbackChain } from "../../src/infrastructure/chat/model-fallback-chain.js";

describe("ModelFallbackChain", () => {
  it("advances to the next model on a 429", async () => {
    const chain = new ModelFallbackChain(["primary", "fallback"]);
    const attempt = (model: string): Promise<string> =>
      model === "primary"
        ? Promise.reject(new ChatProviderError("rate limited", 429, "rate_limit"))
        : Promise.resolve(`ok:${model}`);
    await expect(chain.run(attempt)).resolves.toBe("ok:fallback");
  });

  it("skips a model still in cooldown on a later call", async () => {
    const chain = new ModelFallbackChain(["primary", "fallback"], 60_000);
    let primaryCalls = 0;
    const firstAttempt = (model: string): Promise<string> => {
      if (model === "primary") {
        primaryCalls += 1;
        return Promise.reject(new ChatProviderError("rate limited", 429, "rate_limit"));
      }
      return Promise.resolve("ok");
    };
    const secondAttempt = (model: string): Promise<string> => {
      if (model === "primary") primaryCalls += 1;
      return Promise.resolve(model === "primary" ? "should not happen" : "ok again");
    };
    await chain.run(firstAttempt);
    await chain.run(secondAttempt);
    expect(primaryCalls).toBe(1);
  });

  it("fails fast on a later call once every model is in cooldown", async () => {
    const chain = new ModelFallbackChain(["only"], 60_000);
    const rateLimited = (): Promise<string> =>
      Promise.reject(new ChatProviderError("rate limited", 429, "rate_limit"));
    const shouldNotRun = (): Promise<string> => Promise.resolve("should not run");
    // First call: the only model 429s, its own error surfaces (most
    // informative), and it's now in cooldown.
    await expect(chain.run(rateLimited)).rejects.toThrow(ChatProviderError);
    // Second call: no candidates left outside cooldown, fails fast without
    // even attempting a request.
    await expect(chain.run(shouldNotRun)).rejects.toThrow(ChatModelFallbackExhaustedError);
  });

  it("does not fall through the chain on a non-429 error", async () => {
    const chain = new ModelFallbackChain(["primary", "fallback"]);
    let fallbackCalled = false;
    const attempt = (model: string): Promise<string> => {
      if (model === "primary") return Promise.reject(new ChatProviderError("server error", 500, "server_error"));
      fallbackCalled = true;
      return Promise.resolve("ok");
    };
    await expect(chain.run(attempt)).rejects.toThrow("server error");
    expect(fallbackCalled).toBe(false);
  });
});
