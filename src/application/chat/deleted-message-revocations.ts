import type { Logger } from "pino";
import type { MessageCleanupClaim, MessageRevocationStore } from "./message-revocation-store.js";
import type { ProvenanceDescendant } from "../provenance/provenance-graph.js";

// One kind of derived data to remove for revoked messages. Steps must be idempotent: a pass can run
// again after a crash or an expired lease, and every revocation gets a second, settle pass.
// messageIds also holds the bot replies whose graph ancestry reaches a revoked message, so a step removes
// what cites them too. artifacts lists every artifact whose current graph revision descends from one.
export interface RevocationCleanupStep {
  name: string;
  run(guildId: string, channelId: string, messageIds: readonly string[], artifacts?: readonly ProvenanceDescendant[]): Promise<unknown>;
}

export interface DeletedMessageRevocationsOptions {
  store: MessageRevocationStore;
  // The guild's "honour deleted sources" setting, read at intake only. A committed revocation is
  // cleaned up and enforced even if the setting is turned off later.
  honoured: (guildId: string) => boolean;
  steps: readonly RevocationCleanupStep[];
  // The provenance graph's descendants of the revoked messages. A failure retries the whole pass.
  descendants?: (guildId: string, channelId: string, messageIds: readonly string[]) => Promise<readonly ProvenanceDescendant[]>;
  logger: Logger;
  now?: () => number;
  pollMs?: number;
  batch?: number;
  leaseMs?: number;
  // The settle pass runs this long after the first, to remove anything a turn that was already
  // running at revocation wrote after the first pass.
  settleMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  intakeRetryDelaysMs?: readonly number[];
}

const sleep = (ms: number): Promise<void> => ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

// Durable intake and cleanup for observed Discord deletes. Intake commits the revocation and its
// cleanup work together; readers enforce the revocation from that commit on (see the guarded lease),
// so cleanup only removes stored copies and may lag or retry without exposing anything.
export class DeletedMessageRevocations {
  private readonly now: () => number;
  private readonly pollMs: number; private readonly batch: number; private readonly leaseMs: number; private readonly settleMs: number;
  private readonly retryBaseMs: number; private readonly retryMaxMs: number; private readonly intakeRetryDelaysMs: readonly number[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private stopped = true;

  public constructor(private readonly options: DeletedMessageRevocationsOptions) {
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? 60_000; this.batch = options.batch ?? 100; this.leaseMs = options.leaseMs ?? 5 * 60_000;
    this.settleMs = options.settleMs ?? 15 * 60_000; this.retryBaseMs = options.retryBaseMs ?? 30_000; this.retryMaxMs = options.retryMaxMs ?? 60 * 60_000;
    this.intakeRetryDelaysMs = options.intakeRetryDelaysMs ?? [250, 1_000];
  }

  // Records a delete. Returns false only when the revocation could not be committed; the failure is logged.
  public async intake(guildId: string, channelId: string, messageIds: readonly string[]): Promise<boolean> {
    if (!messageIds.length || !this.options.honoured(guildId)) return true;
    let failure: unknown;
    for (const delay of [0, ...this.intakeRetryDelaysMs]) {
      await sleep(delay);
      try {
        const result = await this.options.store.revoke({ guildId, channelId, messageIds, revokedAt: this.now() });
        if (result.revoked.length) this.wake();
        return true;
      } catch (error) { failure = error; }
    }
    this.options.logger.error({ error: failure, guildId, channelId, messages: messageIds.length },
      "Unable to record deleted messages; they are out of live context, but what was derived from them is not revoked");
    return false;
  }

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), this.pollMs); this.timer.unref?.();
    this.wake();
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public async drain(): Promise<void> { await this.running; }

  private wake(): void {
    if (this.stopped) return;
    if (this.running) { this.rerun = true; return; }
    this.running = (async (): Promise<void> => {
      do {
        this.rerun = false;
        await this.runOnce().catch((error: unknown) => this.options.logger.error({ error }, "Deleted-message cleanup pass failed"));
      } while (this.rerun && !this.stopped);
    })().finally(() => { this.running = null; });
  }

  // Runs every due pass and returns how many rows it completed. Failed passes are retried with backoff.
  public async runOnce(): Promise<number> {
    let completed = 0;
    for (let round = 0; round < 50; round++) {
      const claims = await this.options.store.claimCleanup({ now: this.now(), limit: this.batch, leaseMs: this.leaseMs });
      if (!claims.length) break;
      const groups = new Map<string, MessageCleanupClaim[]>();
      for (const claim of claims) {
        const scope = JSON.stringify([claim.guildId, claim.channelId]);
        groups.set(scope, [...(groups.get(scope) ?? []), claim]);
      }
      for (const group of groups.values()) completed += await this.clean(group);
      if (claims.length < this.batch) break;
    }
    return completed;
  }

  private async clean(claims: readonly MessageCleanupClaim[]): Promise<number> {
    const { guildId, channelId } = claims[0]!; const messageIds = claims.map((claim) => claim.messageId);
    let step = "";
    try {
      step = "graph descendants";
      const artifacts = this.options.descendants ? await this.options.descendants(guildId, channelId, messageIds) : [];
      const reached = [...new Set([...messageIds, ...artifacts.filter((artifact) => artifact.kind === "reply_part").map((artifact) => artifact.artifactId)])];
      for (const entry of this.options.steps) { step = entry.name; await entry.run(guildId, channelId, reached, artifacts); }
    } catch (error) {
      this.options.logger.error({ error, guildId, channelId, messages: messageIds.length, step }, "Deleted-message cleanup failed; it will be retried");
      for (const claim of claims) {
        const retryAt = this.now() + Math.min(this.retryBaseMs * 2 ** claim.attempts, this.retryMaxMs);
        await this.options.store.retryCleanup(claim, { retryAt }).catch(() => false);
      }
      return 0;
    }
    let completed = 0;
    for (const claim of claims) if (await this.options.store.completeCleanup(claim, { now: this.now(), settleMs: this.settleMs })) completed++;
    return completed;
  }
}
