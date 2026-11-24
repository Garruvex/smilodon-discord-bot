import type { RelevanceCalibrationCase, RelevanceCalibrationCandidate } from "../chat/memory-relevance-calibration.js";

export interface MemoryRelevanceTraceInput {
  guildId: string;
  channelId: string;
  message: string;
  recentHistory: readonly string[];
  subjectIds: readonly string[];
  now: number;
  candidates: readonly RelevanceCalibrationCandidate[];
  selectedIds: readonly string[];
  maxSerializedChars: number;
  requireTopicalMatch: boolean;
  // Lineage: the guild messages whose text the sample holds as conversation (the query, recent history
  // and conversational sources of every candidate). A sample without complete lineage is not recorded,
  // so a revoked message can always be traced to the samples that hold it.
  sources?: readonly { channelId: string; messageId: string }[];
}

export interface MemoryRelevanceTrace extends MemoryRelevanceTraceInput {
  id: string;
  recordedAt: number;
}

export interface MemoryRelevanceTraceCollector {
  readonly includePrivate: boolean;
  record(input: MemoryRelevanceTraceInput): Promise<void>;
  latestPending(guildId: string): Promise<MemoryRelevanceTrace | null>;
  label(input: {
    guildId: string;
    traceId: string;
    relevantCandidateIds: readonly string[];
    split: "calibration" | "validation";
  }): Promise<MemoryRelevanceTrace>;
  skip(guildId: string, traceId: string): Promise<MemoryRelevanceTrace>;
  exportCases(guildId?: string): Promise<readonly RelevanceCalibrationCase[]>;
}
