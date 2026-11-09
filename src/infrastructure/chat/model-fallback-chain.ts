import { ChatProviderError } from "../../application/chat/chat-provider.js";
import { performance } from "node:perf_hooks";
import { diagnosticElapsed, emitChatDiagnostic, safeFailure } from "../../application/diagnostics/chat-diagnostics.js";
import { modelDiagnosticLogger } from "../../application/diagnostics/model-diagnostics.js";

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

  public async run<T>(attempt: (model: string) => Promise<T>, options?: { maxAttempts?: number; signal?: AbortSignal }): Promise<T> {
    const now = Date.now();
    for (const [modelIndex, model] of this.models.entries()) if ((this.cooldownUntil.get(model) ?? 0) > now)
      emitChatDiagnostic(modelDiagnosticLogger(), { event: "model.provider.attempt", modelIndex, attempt: 0, status: "cooldown", durationMs: 0 });
    const candidates = this.models.filter((model) => (this.cooldownUntil.get(model) ?? 0) <= now).slice(0, options?.maxAttempts ?? Infinity);
    if (candidates.length === 0) throw new ChatModelFallbackExhaustedError();

    let lastError: unknown;
    for (const model of candidates) {
      options?.signal?.throwIfAborted();
      try {
        return await this.attemptWithStreamRetry(attempt, model, options?.maxAttempts !== 1);
      } catch (error) {
        lastError = error;
        if (error instanceof ChatProviderError) {
          if (error.status === 429) {
            this.cooldownUntil.set(model, Date.now() + this.cooldownMs);
            continue;
          }
          // Structured-output calls validate inside the attempt so an
          // incomplete or malformed result can use the configured fallback
          // model instead of permanently failing the background batch.
          if (error.code === "incomplete_response" || error.code === "invalid_structured_output") continue;
        }
        throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new ChatModelFallbackExhaustedError();
  }

  // A stream that closes with no response.completed and no explicit error
  // event is a dropped connection, not a quota or capability signal — retried
  // once on the same model before falling into the normal (non-retrying)
  // error path above.
  private async attemptWithStreamRetry<T>(attempt: (model: string) => Promise<T>, model: string, retryStream: boolean): Promise<T> {
    let ordinal = 0;
    const traced = async (): Promise<T> => {
      const started = performance.now(); const number = ++ordinal;
      try {
        const result = await attempt(model);
        emitChatDiagnostic(modelDiagnosticLogger(), { event: "model.provider.attempt", modelIndex: this.models.indexOf(model), attempt: number, status: "completed", durationMs: diagnosticElapsed(started) });
        return result;
      } catch (error) {
        emitChatDiagnostic(modelDiagnosticLogger(), { event: "model.provider.attempt", modelIndex: this.models.indexOf(model), attempt: number, status: "failed", durationMs: diagnosticElapsed(started), ...safeFailure(error) });
        throw error;
      }
    };
    try {
      return await traced();
    } catch (error) {
      if (retryStream && error instanceof ChatProviderError && error.code === "incomplete_stream") {
        return await traced();
      }
      throw error;
    }
  }
}
