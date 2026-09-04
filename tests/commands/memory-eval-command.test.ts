import { describe, expect, it, vi } from "vitest";

import { CommandResponseVisibility, type CommandContext } from "../../src/application/commands/command.js";
import type {
  MemoryRelevanceTrace,
  MemoryRelevanceTraceCollector,
} from "../../src/application/memory/memory-relevance-trace.js";
import { MemoryEvalCommand } from "../../src/infrastructure/discord/commands/diagnostics/memory-eval-command.js";

const trace: MemoryRelevanceTrace = {
  id: "trace-12345678",
  recordedAt: 1_000,
  guildId: "guild",
  channelId: "general",
  message: "what fruit does alice like",
  recentHistory: [],
  subjectIds: ["alice"],
  now: 900,
  candidates: [
    {
      id: "candidate-apples", subjectId: "alice", topic: "preference", slot: "food.fruit",
      statement: "likes green apples", updatedAt: 100,
    },
    {
      id: "candidate-role", subjectId: "alice", topic: "identity", slot: "role",
      statement: "works as an engineer", updatedAt: 800,
    },
  ],
  selectedIds: ["candidate-apples"],
  maxSerializedChars: 8_000,
  requireTopicalMatch: false,
};

function collector(): MemoryRelevanceTraceCollector {
  return {
    includePrivate: false,
    record: vi.fn().mockResolvedValue(undefined),
    latestPending: vi.fn().mockResolvedValue(trace),
    label: vi.fn().mockResolvedValue(trace),
    skip: vi.fn().mockResolvedValue(trace),
    exportCases: vi.fn().mockResolvedValue([]),
  };
}

function context(subcommand: string, strings: Record<string, string> = {}): {
  value: CommandContext;
  reply: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn().mockResolvedValue(undefined);
  const error = vi.fn().mockResolvedValue(undefined);
  return {
    value: {
      interaction: {
        guildId: "guild",
        options: {
          getSubcommand: () => subcommand,
          getString: (name: string) => strings[name] ?? null,
        },
      },
      responses: { reply, error },
      logger: {},
    } as unknown as CommandContext,
    reply,
    error,
  };
}

describe("MemoryEvalCommand", () => {
  it("is owner-only and always responds ephemerally", () => {
    const command = new MemoryEvalCommand(collector());
    expect(command.access.ownerOnly).toBe(true);
    expect(command.responseVisibility).toBe(CommandResponseVisibility.Ephemeral);
  });

  it("shows selected and unselected candidates in a pending trace", async () => {
    const command = new MemoryEvalCommand(collector());
    const testContext = context("pending");
    await command.execute(testContext.value);

    expect(testContext.reply).toHaveBeenCalledWith(expect.stringContaining("trace-12"));
    expect(testContext.reply).toHaveBeenCalledWith(expect.stringContaining("likes green apples"));
  });

  it("passes reviewer labels and the held-out split to the collector", async () => {
    const label = vi.fn().mockResolvedValue(trace);
    const traceCollector = { ...collector(), label };
    const command = new MemoryEvalCommand(traceCollector);
    const testContext = context("label", {
      trace: "trace-12",
      relevant: "candidate-a, candidate-r",
      split: "validation",
    });
    await command.execute(testContext.value);

    expect(label).toHaveBeenCalledWith({
      guildId: "guild",
      traceId: "trace-12",
      relevantCandidateIds: ["candidate-a", "candidate-r"],
      split: "validation",
    });
  });

  it("accepts an omitted 'relevant' option as a valid 'nothing here was relevant' label, not an error", async () => {
    // Without this, the dataset could never contain a false-positive
    // example — every labeled trace would necessarily claim at least one
    // candidate was relevant, even when the honest answer is none were.
    const label = vi.fn().mockResolvedValue(trace);
    const traceCollector = { ...collector(), label };
    const command = new MemoryEvalCommand(traceCollector);
    const testContext = context("label", { trace: "trace-12", split: "calibration" }); // no "relevant" key
    await command.execute(testContext.value);

    expect(testContext.error).not.toHaveBeenCalled();
    expect(label).toHaveBeenCalledWith({
      guildId: "guild",
      traceId: "trace-12",
      relevantCandidateIds: [],
      split: "calibration",
    });
  });
});
