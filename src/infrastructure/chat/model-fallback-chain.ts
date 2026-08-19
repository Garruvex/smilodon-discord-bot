import { ChatProviderError } from "../../application/chat/chat-provider.js";

export class ChatModelFallbackExhaustedError extends ChatProviderError {
  public constructor() {
    super("All configured chat models are rate-limited right now.", 429, "all_models_exhausted");
  }
}

// Walks an ordered (primary, ...fallback) model list on 429/quota exhaustion.
// A model that 429s is put in cooldown and skipped by every call for the
// next `cooldownMs`, so a single quota-exhausted model doesn't get retried
// (and re-429 immediately) on every subsequent request. Any other error
// (5xx, network, etc.) is not a quota signal — it rethrows immediately
// rather than blindly falling through the rest of the chain, since a
// non-quota failure is not something switching models fixes.
export class ModelFallbackChain {
  private readonly cooldownUntil = new Map<string, number>();

  public constructor(
    private readonly models: readonly string[],
    private readonly cooldownMs = 60_000,
  ) {
    if (models.length === 0) throw new Error("ModelFallbackChain requires at least one model.");
  }

  public async run<T>(attempt: (model: string) => Promise<T>): Promise<T> {
    const now = Date.now();
    const candidates = this.models.filter((model) => (this.cooldownUntil.get(model) ?? 0) <= now);
    if (candidates.length === 0) throw new ChatModelFallbackExhaustedError();

    let lastError: unknown;
    for (const model of candidates) {
      try {
        return await attempt(model);
      } catch (error) {
        lastError = error;
        if (error instanceof ChatProviderError && error.status === 429) {
          this.cooldownUntil.set(model, Date.now() + this.cooldownMs);
          continue;
        }
        throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new ChatModelFallbackExhaustedError();
  }
}
