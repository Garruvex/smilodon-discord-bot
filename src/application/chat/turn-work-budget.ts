export const contextualTurnLimits = { totalMs: 30000, generationReserveMs: 10000, minimumAttemptMs: 1000 } as const;
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
