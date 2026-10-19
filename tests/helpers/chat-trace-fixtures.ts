import { diagnosticProcessRunId, type ChatDiagnosticRecord } from "../../src/application/diagnostics/chat-diagnostics.js";
import { BoundedChatTraceBuffer, type ChatTraceStore, type RetainedChatTrace, type TraceQuery, type TraceStoreStatus } from "../../src/application/diagnostics/chat-trace-store.js";

export function diagnosticRecord(overrides: Partial<ChatDiagnosticRecord> = {}): ChatDiagnosticRecord {
  return { schemaVersion: 1, processRunId: diagnosticProcessRunId, timestampMs: 1000, eventSequence: 1,
    scope: { operation: "chat_turn", traceId: "trace", spanId: "span", traceSequence: 1,
      guildId: "guild", channelId: "channel", sourceMessageId: "source" },
    data: { event: "chat.turn.started", triggerMode: "direct" }, ...overrides };
}

export class MemoryChatTraceStore implements ChatTraceStore {
  public readonly buffer = new BoundedChatTraceBuffer();
  public record(record: ChatDiagnosticRecord): void { this.buffer.record(record); }
  public lookup(query: TraceQuery): readonly RetainedChatTrace[] { return this.buffer.lookup(query); }
  public status(): TraceStoreStatus { return this.buffer.status(); }
  public forgetGuild(guildId: string, beforeSequence: number): Promise<void> { this.buffer.forgetGuild(guildId, beforeSequence); return Promise.resolve(); }
  public excludeSource(query: TraceQuery, beforeSequence: number): void { this.buffer.excludeSource(query, beforeSequence); }
  public flush(): Promise<void> { return Promise.resolve(); }
}
