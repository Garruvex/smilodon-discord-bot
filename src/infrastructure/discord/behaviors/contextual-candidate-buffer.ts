import { randomUUID } from "node:crypto";
import type { Message } from "discord.js";
import { bindDiagnosticTask, emitChatDiagnostic, type DiagnosticLogger } from "../../../application/diagnostics/chat-diagnostics.js";

export const contextualBufferLimits = { pauseMs: 5000, maxWaitMs: 15000, expiryMs: 60000, channels: 256, messages: 20 } as const;
interface Batch { id: string; messages: Message[]; seen: Set<string>; firstAt: number; fingerprint: string; timer: ReturnType<typeof setTimeout> | null;
  report: (action: "buffered" | "coalesced" | "scheduled" | "submitted" | "cancelled" | "expired", reason: "accepted" | "cooldown" | "ready" | "changed" | "capacity" | "ineligible" | "deadline", delayMs?: number) => void }
export class ContextualCandidateBuffer {
  private readonly batches = new Map<string, Batch>();
  private readonly seen = new Map<string, number>();
  public constructor(private readonly logger: DiagnosticLogger, private readonly dependencies: {
    fingerprint: (message: Message) => string | null;
    delay: (message: Message) => number;
    threshold: (message: Message) => number;
    eligible: (message: Message) => Promise<boolean>;
    schedule: (message: Message, work: () => void) => void;
    evaluate: (message: Message, burst: readonly Message[], candidateId: string) => Promise<void>;
  }) {}
  public cancel(message: Message, reason: "changed" | "ineligible" = "changed"): void {
    const key = `${message.guildId}:${message.channelId}`; const batch = this.batches.get(key);
    if (batch) { if (batch.timer) clearTimeout(batch.timer); batch.report("cancelled", reason); this.batches.delete(key); }
  }
  public add(message: Message): void {
    const key = `${message.guildId}:${message.channelId}`; const fingerprint = this.dependencies.fingerprint(message);
    if (fingerprint === null) { this.cancel(message); return; }
    const sourceKey = `${key}:${message.id}`;
    for (const [id, at] of this.seen) { if (at > Date.now() - 600000) break; this.seen.delete(id); }
    if (this.seen.has(sourceKey)) return;
    let batch = this.batches.get(key);
    if (batch && batch.fingerprint !== fingerprint) { this.cancel(message); batch = undefined; }
    if (!batch) {
      if (this.batches.size >= contextualBufferLimits.channels) {
        const [oldestKey, oldest] = this.batches.entries().next().value!;
        if (oldest.timer) clearTimeout(oldest.timer); oldest.report("cancelled", "capacity"); this.batches.delete(oldestKey);
      }
      const id = randomUUID(); let terminal = false;
      batch = { id, messages: [], seen: new Set(), firstAt: Date.now(), fingerprint, timer: null,
        report: bindDiagnosticTask((action, reason, delayMs = 0) => {
          if (terminal) return;
          emitChatDiagnostic(this.logger, { event: "chat.candidate.changed", candidateId: id, action, reason, delayMs, messages: batch!.messages.length });
          terminal = action === "submitted" || action === "cancelled" || action === "expired";
        }) };
      this.batches.set(key, batch); batch.report("buffered", "accepted");
    }
    if (batch.seen.has(message.id)) return;
    // Capacity ends this candidate explicitly; the next message starts a new
    // candidate rather than silently removing an earlier speaker's event.
    if (batch.messages.length >= contextualBufferLimits.messages) { this.cancel(message); this.add(message); return; }
    if (this.seen.size >= 10000) this.seen.delete(this.seen.keys().next().value!);
    this.seen.set(sourceKey, Date.now());
    batch.messages.push(message); batch.seen.add(message.id);
    emitChatDiagnostic(this.logger, { event: "chat.candidate.source", candidateId: batch.id, sourceMessageId: message.id });
    if (batch.messages.length > 1) batch.report("coalesced", "accepted");
    if (batch.timer) clearTimeout(batch.timer);
    const pause = batch.messages.length >= this.dependencies.threshold(message) ? 0 :
      Math.min(contextualBufferLimits.pauseMs, Math.max(0, batch.firstAt + contextualBufferLimits.maxWaitMs - Date.now()));
    const cooldown = this.dependencies.delay(message);
    const expiry = Math.max(0, batch.firstAt + contextualBufferLimits.expiryMs - Date.now());
    const delay = Math.min(Math.max(pause, cooldown), expiry);
    batch.report("scheduled", cooldown > pause ? "cooldown" : "accepted", delay);
    const selected = batch;
    batch.timer = setTimeout(() => {
      if (Date.now() >= selected.firstAt + contextualBufferLimits.expiryMs) {
        selected.report("expired", "deadline"); this.batches.delete(key); return;
      }
      this.dependencies.schedule(message, () => { void this.flush(key, selected).catch(() => {
        if (this.batches.get(key) === selected) this.cancel(message, "ineligible");
      }); });
      selected.timer = setTimeout(() => {
        if (this.batches.get(key) === selected) { selected.report("expired", "deadline"); this.batches.delete(key); }
      }, Math.max(0, selected.firstAt + contextualBufferLimits.expiryMs - Date.now()));
      selected.timer.unref?.();
    }, delay);
    batch.timer.unref?.();
  }
  private async flush(key: string, batch: Batch): Promise<void> {
    if (this.batches.get(key) !== batch) return;
    const latest = batch.messages.at(-1)!;
    if (Date.now() >= batch.firstAt + contextualBufferLimits.expiryMs) { batch.report("expired", "deadline"); this.batches.delete(key); return; }
    if (this.dependencies.fingerprint(latest) !== batch.fingerprint) { this.cancel(latest); return; }
    const snapshot = [...batch.messages];
    const allowed = await Promise.all(snapshot.map((item) => this.dependencies.eligible(item)));
    if (this.batches.get(key) !== batch || batch.messages.at(-1) !== snapshot.at(-1)) return;
    if (allowed.some((value) => !value)) { this.cancel(latest, "ineligible"); return; }
    if (batch.timer) clearTimeout(batch.timer);
    batch.report("submitted", "ready"); this.batches.delete(key);
    await this.dependencies.evaluate(latest, snapshot, batch.id);
  }
}
