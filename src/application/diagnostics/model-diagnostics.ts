import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { diagnosticElapsed, diagnosticFields, emitChatDiagnostic, safeFailure, withDiagnosticScope, type DiagnosticLogger } from "./chat-diagnostics.js";

const modelLoggers = new AsyncLocalStorage<DiagnosticLogger>();
export function modelDiagnosticLogger(): DiagnosticLogger | null { return modelLoggers.getStore() ?? null; }

// Explicit capability allow-list: preserve missing optional capabilities and
// the receiver's private fields. Never inspect arguments, results, or prompts.
const capabilities = new Set(["reply", "generateCharacterData", "analyzeUserCustomization", "summarizeDroppedExchanges",
  "classifyMemoryConflict", "summarizeReplyChainOverflow", "verifyAttribution", "extractPersonalMemories",
  "compilePersonaBundle", "evolvePersonaDrift", "summarizeChannelMessages", "generateReferenceImage", "embed", "embedMany"]);

export function instrumentModel<T extends object>(provider: T, logger: DiagnosticLogger): T {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(provider, { get(target, key, receiver): unknown {
    const value: unknown = Reflect.get(target, key, receiver);
    if (typeof key !== "string" || !capabilities.has(key) || typeof value !== "function") return value;
    if (!methods.has(key)) methods.set(key, (...args: unknown[]) => {
      const scope = diagnosticFields();
      return withDiagnosticScope({ operation: "model", guildId: scope.guildId, channelId: scope.channelId, sourceMessageId: scope.sourceMessageId }, () => modelLoggers.run(logger, async () => {
        const started = performance.now();
        try {
          const result: unknown = await Reflect.apply(value, target, args);
          const reportedFailure = result !== null && typeof result === "object" && "ok" in result && result.ok === false;
          emitChatDiagnostic(logger, { event: "model.operation.completed", purpose: key, status: reportedFailure ? "reported_failure" : "completed", durationMs: diagnosticElapsed(started) });
          return result;
        } catch (error) {
          emitChatDiagnostic(logger, { event: "model.operation.completed", purpose: key, status: "failed", durationMs: diagnosticElapsed(started), ...safeFailure(error) });
          throw error;
        }
      }));
    });
    return methods.get(key);
  } });
}
