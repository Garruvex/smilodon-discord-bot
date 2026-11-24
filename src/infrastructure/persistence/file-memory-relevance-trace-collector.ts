import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import type { RelevanceCalibrationCase } from "../../application/chat/memory-relevance-calibration.js";
import type {
  MemoryRelevanceTrace,
  MemoryRelevanceTraceCollector,
  MemoryRelevanceTraceInput,
} from "../../application/memory/memory-relevance-trace.js";
import type { MessageRevocationKey } from "../../application/chat/message-revocation-store.js";

const candidateSchema = z.object({
  id: z.string(), subjectId: z.string(), topic: z.string(), slot: z.string(),
  statement: z.string(), updatedAt: z.number(), serializedChars: z.number().int().positive().optional(),
  cosineSimilarity: z.number().min(0).max(1).optional(), relationBoost: z.number().nonnegative().optional(),
});

const traceSchema = z.object({
  type: z.literal("trace"), id: z.string(), recordedAt: z.number(),
  guildId: z.string(), channelId: z.string(), message: z.string(),
  recentHistory: z.array(z.string()), subjectIds: z.array(z.string()), now: z.number(),
  candidates: z.array(candidateSchema), selectedIds: z.array(z.string()),
  maxSerializedChars: z.number(), requireTopicalMatch: z.boolean(),
  // Absent on legacy samples recorded before lineage was kept.
  sources: z.array(z.object({ channelId: z.string(), messageId: z.string() })).max(4096).optional(),
});

// Committed revocations, consulted on every append, review, label and export. A sample with lineage is
// hidden when any of its sources is revoked. A legacy sample without lineage is hidden once its guild
// has any revocation committed after it was recorded, because it could hold the revoked text.
export interface TraceRevocations {
  revoked(keys: readonly MessageRevocationKey[]): Promise<readonly boolean[]>;
  latestRevocationAt(guildId: string): Promise<number | null>;
}

const decisionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("label"), traceId: z.string(), decidedAt: z.number(),
    relevantCandidateIds: z.array(z.string()), split: z.enum(["calibration", "validation"]),
  }),
  z.object({ type: z.literal("skip"), traceId: z.string(), decidedAt: z.number() }),
]);

type Decision = z.infer<typeof decisionSchema>;

export class FileMemoryRelevanceTraceCollector implements MemoryRelevanceTraceCollector {
  private readonly file: string;
  private operationTail: Promise<void> = Promise.resolve();

  public constructor(
    runtimeDataDirectory: string,
    private readonly sampleRate: number,
    public readonly includePrivate = false,
  ) {
    this.file = resolve(runtimeDataDirectory, "memory-relevance", "traces.jsonl");
  }

  private revocations: TraceRevocations | null = null;
  public bindRevocations(revocations: TraceRevocations): void { this.revocations = revocations; }

  public record(input: MemoryRelevanceTraceInput): Promise<void> {
    // Without complete lineage a later delete could not find this sample, so it is not kept.
    if (!input.sources || Math.random() >= this.sampleRate || input.candidates.length < 2) return Promise.resolve();
    return this.enqueue(async () => {
      const event = { type: "trace" as const, id: randomUUID(), recordedAt: Date.now(), ...input };
      if (!(await this.visible([event])).length) return;
      await this.append(event);
    });
  }

  public latestPending(guildId: string): Promise<MemoryRelevanceTrace | null> {
    return this.enqueue(async () => {
      const { traces, decisions } = await this.load();
      return [...await this.visible(traces.filter((trace) => trace.guildId === guildId && !decisions.has(trace.id)))].pop() ?? null;
    });
  }

  // Revocation cleanup: removes samples that hold one of these messages, with their decisions. Legacy
  // samples without lineage in this guild are removed too, since they could hold it. Runs on the same
  // queue as appends, and replaces the file atomically, so no new sample is lost and none restored.
  public forgetCitingMessages(guildId: string, channelId: string, messageIds: readonly string[]): Promise<number> {
    const ids = new Set(messageIds);
    return this.enqueue(async () => {
      let content: string;
      try { content = await readFile(this.file, "utf8"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      }
      const parsed = content.split("\n").filter((line) => line.trim()).map((line) => {
        try { return { line, value: JSON.parse(line) as unknown }; } catch { return { line, value: null }; }
      });
      const removed = new Set<string>();
      for (const { value } of parsed) {
        const trace = traceSchema.safeParse(value); if (!trace.success || trace.data.guildId !== guildId) continue;
        if (!trace.data.sources || trace.data.sources.some((source) => source.channelId === channelId && ids.has(source.messageId))) removed.add(trace.data.id);
      }
      if (!removed.size) return 0;
      // Unparseable lines (an interrupted append) are dropped as well: they cannot be attributed.
      const kept = parsed.filter(({ value }) => {
        if (value === null) return false;
        const trace = traceSchema.safeParse(value); if (trace.success) return !removed.has(trace.data.id);
        const decision = decisionSchema.safeParse(value); return !decision.success || !removed.has(decision.data.traceId);
      }).map(({ line }) => line);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
      await rename(temporary, this.file);
      return removed.size;
    });
  }

  // Samples that no committed revocation reaches. Fails closed: if the check errors, nothing is visible.
  private async visible<T extends Pick<MemoryRelevanceTrace, "guildId" | "recordedAt" | "sources">>(traces: readonly T[]): Promise<T[]> {
    if (!this.revocations || !traces.length) return [...traces];
    try {
      const keys = traces.flatMap((trace) => (trace.sources ?? []).map((source) => ({ guildId: trace.guildId, ...source })));
      const answers = keys.length ? await this.revocations.revoked(keys) : [];
      if (answers.length !== keys.length) return [];
      const revoked = new Set(keys.filter((_key, index) => answers[index] !== false).map((key) => JSON.stringify([key.guildId, key.channelId, key.messageId])));
      const latest = new Map<string, number | null>();
      for (const guildId of new Set(traces.filter((trace) => !trace.sources).map((trace) => trace.guildId))) latest.set(guildId, await this.revocations.latestRevocationAt(guildId));
      return traces.filter((trace) => trace.sources
        ? !trace.sources.some((source) => revoked.has(JSON.stringify([trace.guildId, source.channelId, source.messageId])))
        : (latest.get(trace.guildId) ?? null) === null || trace.recordedAt > latest.get(trace.guildId)!);
    } catch { return []; }
  }

  public label(input: {
    guildId: string;
    traceId: string;
    relevantCandidateIds: readonly string[];
    split: "calibration" | "validation";
  }): Promise<MemoryRelevanceTrace> {
    return this.enqueue(async () => {
      const { traces, decisions } = await this.load();
      const trace = this.resolveTrace(await this.visible(traces.filter((entry) => entry.guildId === input.guildId)), input.guildId, input.traceId);
      if (decisions.has(trace.id)) throw new Error("That trace has already been reviewed.");
      const relevantCandidateIds = input.relevantCandidateIds.map((id) =>
        this.resolveCandidateId(trace, id));
      await this.append({
        type: "label", traceId: trace.id, decidedAt: Date.now(),
        relevantCandidateIds: [...new Set(relevantCandidateIds)], split: input.split,
      });
      return trace;
    });
  }

  public skip(guildId: string, traceId: string): Promise<MemoryRelevanceTrace> {
    return this.enqueue(async () => {
      const { traces, decisions } = await this.load();
      const trace = this.resolveTrace(await this.visible(traces.filter((entry) => entry.guildId === guildId)), guildId, traceId);
      if (decisions.has(trace.id)) throw new Error("That trace has already been reviewed.");
      await this.append({ type: "skip", traceId: trace.id, decidedAt: Date.now() });
      return trace;
    });
  }

  public exportCases(guildId?: string): Promise<readonly RelevanceCalibrationCase[]> {
    return this.enqueue(async () => {
      const { traces, decisions } = await this.load();
      const cases: RelevanceCalibrationCase[] = [];
      for (const trace of await this.visible(traces.filter((trace) => guildId === undefined || trace.guildId === guildId))) {
        const decision = decisions.get(trace.id);
        if (!decision || decision.type !== "label") continue;
        cases.push({
          id: trace.id,
          split: decision.split,
          message: trace.message,
          recentHistory: trace.recentHistory,
          subjectIds: trace.subjectIds,
          now: trace.now,
          candidates: trace.candidates,
          relevantIds: decision.relevantCandidateIds,
          maxSerializedChars: trace.maxSerializedChars,
          requireTopicalMatch: trace.requireTopicalMatch,
        });
      }
      return cases;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async append(event: unknown): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(event)}\n`, "utf8");
  }

  private async load(): Promise<{
    traces: MemoryRelevanceTrace[];
    decisions: Map<string, Decision>;
  }> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { traces: [], decisions: new Map() };
      throw error;
    }
    const traces: MemoryRelevanceTrace[] = [];
    const decisions = new Map<string, Decision>();
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A process interruption can leave only the final JSONL line partial;
        // earlier complete samples remain reviewable.
        continue;
      }
      const trace = traceSchema.safeParse(parsed);
      if (trace.success) {
        const { type: _type, sources, ...value } = trace.data;
        traces.push(sources ? { ...value, sources } : value);
        continue;
      }
      const decision = decisionSchema.safeParse(parsed);
      if (decision.success) decisions.set(decision.data.traceId, decision.data);
    }
    return { traces, decisions };
  }

  private resolveTrace(
    traces: readonly MemoryRelevanceTrace[],
    guildId: string,
    idOrPrefix: string,
  ): MemoryRelevanceTrace {
    const matches = traces.filter((trace) => trace.guildId === guildId &&
      (trace.id === idOrPrefix || trace.id.startsWith(idOrPrefix)));
    if (matches.length === 0) throw new Error("Trace not found in this server.");
    if (matches.length > 1) throw new Error("Trace prefix is ambiguous; provide more characters.");
    return matches[0]!;
  }

  private resolveCandidateId(trace: MemoryRelevanceTrace, idOrPrefix: string): string {
    const matches = trace.candidates.filter((candidate) =>
      candidate.id === idOrPrefix || candidate.id.startsWith(idOrPrefix));
    if (matches.length === 0) throw new Error(`Candidate "${idOrPrefix}" is not in that trace.`);
    if (matches.length > 1) throw new Error(`Candidate prefix "${idOrPrefix}" is ambiguous.`);
    return matches[0]!.id;
  }
}
