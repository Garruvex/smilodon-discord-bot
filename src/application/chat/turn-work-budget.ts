import { isOptionalInteraction, type ChatInteraction } from "./chat-policy.js";

export const contextualTurnLimits = { totalMs: 30000, generationReserveMs: 10000, minimumAttemptMs: 1000 } as const;

// How long a turn may spend confirming memory sources. Each check can wait on Discord's rate
// limit for old source messages, so an unbounded check can spend the whole turn deadline before
// the model is called. Memories left unchecked are left out of the turn.
export const memoryVerificationLimits = { optionalMs: 6_000, addressedMs: 10_000 } as const;
export function memoryVerificationBudgetMs(interaction: ChatInteraction, now: number, deadlineAt?: number): number {
  if (isOptionalInteraction(interaction)) return memoryVerificationLimits.optionalMs;
  // An addressed turn must answer, so it always keeps the generation reserve for the model.
  const remaining = deadlineAt === undefined ? memoryVerificationLimits.addressedMs : deadlineAt - now - contextualTurnLimits.generationReserveMs;
  return Math.max(0, Math.min(memoryVerificationLimits.addressedMs, remaining));
}
export function assertTurnActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Chat turn deadline exceeded", "TimeoutError");
}
// Also releases callers awaiting dependencies that do not implement abort.
// Before any later side effect, the caller must check the same signal again.
export async function withTurnAbort<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  assertTurnActive(signal);
  if (!signal) return operation();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => { assertTurnActive(signal); return operation(); }), new Promise<never>((_resolve, reject) => {
      abort = (): void => reject(new DOMException("Chat turn deadline exceeded", "TimeoutError"));
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}
