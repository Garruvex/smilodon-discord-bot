import { AsyncLocalStorage } from "node:async_hooks";
import { emitChatDiagnostic, withoutDiagnosticScope, type DiagnosticLogger } from "./chat-diagnostics.js";

export type DiscordCaller = "chat_text" | "chat_reaction" | "control_panel" | "lyrics_panel" | "queue_panel" | "vote_panel" | "now_playing_panel" | "unknown";
const callers = new AsyncLocalStorage<DiscordCaller>();
export function withDiscordCaller<T>(caller: DiscordCaller, task: () => T): T { return callers.run(caller, task); }
export function currentDiscordCaller(): DiscordCaller { return callers.getStore() ?? "unknown"; }

interface Bucket {
  caller: DiscordCaller; kind: "response_429" | "proactive_wait" | "mixed"; method: "POST" | "PATCH" | "GET" | "DELETE" | "OTHER";
  channelId?: string; targetMessageId?: string; count: number; maxWaitMs: number;
}

// Never store URLs, request/response bodies, headers, or arbitrary route text.
// Overflow folds into one bucket rather than evicting and logging per request.
export class DiscordRateLimitDiagnostics {
  private readonly buckets = new Map<string, Bucket>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  public constructor(private readonly logger: DiagnosticLogger, private readonly maxBuckets = 100) {}
  public observe(input: { kind: Bucket["kind"]; method: string; path: string; waitMs?: number }): void {
    if (this.stopped) return;
    try {
      const path = /^\/channels\/(\d{17,20})\/messages(?:\/(\d{17,20}))?(?:[/?]|$)/u.exec(input.path.replace(/^https:\/\/[^/]+\/api\/v\d+/u, ""));
      const method = (["POST", "PATCH", "GET", "DELETE"].includes(input.method) ? input.method : "OTHER") as Bucket["method"];
      const candidate: Bucket = { caller: currentDiscordCaller(), kind: input.kind, method,
        ...(path ? { channelId: path[1]!, ...(path[2] ? { targetMessageId: path[2] } : {}) } : {}), count: 0, maxWaitMs: 0 };
      let key = JSON.stringify(candidate);
      if (!this.buckets.has(key) && this.buckets.size >= this.maxBuckets) key = "overflow";
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = key === "overflow" ? { caller: "unknown", kind: "mixed", method: "OTHER", count: 0, maxWaitMs: 0 } : candidate;
        this.buckets.set(key, bucket);
      }
      bucket.count++;
      if (Number.isFinite(input.waitMs) && input.waitMs! > 0) bucket.maxWaitMs = Math.min(86_400_000, Math.max(bucket.maxWaitMs, input.waitMs!));
      if (!this.timer) { this.timer = setInterval(() => this.flush(), 60_000); this.timer.unref?.(); }
    } catch { /* Observability must not alter REST retries. */ }
  }
  public flush(): void {
    const buckets = [...this.buckets.entries()]; this.buckets.clear();
    // One bucket may cover many requests. Never attach its totals to the
    // first request's trace through the interval's inherited async context.
    withoutDiagnosticScope(() => {
      for (const [key, bucket] of buckets) emitChatDiagnostic(this.logger, { event: "discord.rate_limit.summary", ...bucket, overflow: key === "overflow" });
    });
  }
  public stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; this.flush(); }
}
