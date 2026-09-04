import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import type { RelevanceCalibrationCase } from "../../application/chat/memory-relevance-calibration.js";
import type {
  MemoryRelevanceTrace,
  MemoryRelevanceTraceCollector,
  MemoryRelevanceTraceInput,
} from "../../application/memory/memory-relevance-trace.js";

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
});

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

  public record(input: MemoryRelevanceTraceInput): Promise<void> {
    if (Math.random() >= this.sampleRate || input.candidates.length < 2) return Promise.resolve();
    return this.enqueue(async () => {
      const event = { type: "trace" as const, id: randomUUID(), recordedAt: Date.now(), ...input };
      await this.append(event);
    });
  }

  public latestPending(guildId: string): Promise<MemoryRelevanceTrace | null> {
    return this.enqueue(async () => {
      const { traces, decisions } = await this.load();
      return [...traces].reverse().find((trace) =>
        trace.guildId === guildId && !decisions.has(trace.id)) ?? null;
    });
  }

  public label(input: {
    guildId: string;
    traceId: string;
    relevantCandidateIds: readonly string[];
    split: "calibration" | "validation";
  }): Promise<MemoryRelevanceTrace> {
    return this.enqueue(async () => {
      const { traces, decisions } = await this.load();
      const trace = this.resolveTrace(traces, input.guildId, input.traceId);
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
      const trace = this.resolveTrace(traces, guildId, traceId);
      if (decisions.has(trace.id)) throw new Error("That trace has already been reviewed.");
      await this.append({ type: "skip", traceId: trace.id, decidedAt: Date.now() });
      return trace;
    });
  }

  public exportCases(guildId?: string): Promise<readonly RelevanceCalibrationCase[]> {
    return this.enqueue(async () => {
      const { traces, decisions } = await this.load();
      const cases: RelevanceCalibrationCase[] = [];
      for (const trace of traces) {
        if (guildId !== undefined && trace.guildId !== guildId) continue;
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
        const { type: _type, ...value } = trace.data;
        traces.push(value);
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
