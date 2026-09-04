import { Buffer } from "node:buffer";

import {
  CommandModule,
  CommandResponseVisibility,
  type BotCommand,
  type CommandContext,
} from "../../../../application/commands/command.js";
import type {
  MemoryRelevanceTrace,
  MemoryRelevanceTraceCollector,
} from "../../../../application/memory/memory-relevance-trace.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

const ownerOnlyAccessPolicy = { ...publicAccessPolicy, ownerOnly: true };

export class MemoryEvalCommand implements BotCommand {
  public readonly definition = {
    name: "memory-eval",
    description: "Review sampled memory retrievals for relevance calibration.",
    subcommands: [
      { name: "pending", description: "Shows the newest unreviewed retrieval sample." },
      {
        name: "label",
        description: "Marks the candidates that should have been retrieved.",
        options: [
          { type: "string", name: "trace", description: "Trace ID shown by /memory-eval pending.", required: true },
          {
            type: "string", name: "relevant", required: false, maxLength: 1_000,
            description: "Comma-separated candidate IDs that are relevant. Omit if none of them were — that's a valid label.",
          },
          {
            type: "string", name: "split", description: "Dataset split.", required: true,
            choices: [
              { name: "Calibration", value: "calibration" },
              { name: "Validation", value: "validation" },
            ],
          },
        ],
      },
      {
        name: "skip", description: "Skips an unusable or ambiguous sample.",
        options: [
          { type: "string", name: "trace", description: "Trace ID shown by /memory-eval pending.", required: true },
        ],
      },
      { name: "export", description: "Downloads reviewed cases as a calibration dataset." },
    ],
  } satisfies BotCommand["definition"];

  // Operational owner-only command: available independently of the optional
  // public diagnostics feature whenever collection is enabled at startup.
  public readonly module = CommandModule.Bootstrap;
  public readonly access = ownerOnlyAccessPolicy;
  public readonly responseVisibility = CommandResponseVisibility.Ephemeral;

  public constructor(private readonly collector: MemoryRelevanceTraceCollector) {}

  public async execute(context: CommandContext): Promise<void> {
    const guildId = context.interaction.guildId;
    if (!guildId) {
      await context.responses.reply("This only works in a server.");
      return;
    }
    const subcommand = context.interaction.options.getSubcommand(true);
    try {
      if (subcommand === "pending") {
        await this.pending(context, guildId);
      } else if (subcommand === "label") {
        await this.label(context, guildId);
      } else if (subcommand === "skip") {
        await this.skip(context, guildId);
      } else {
        await this.export(context, guildId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "The relevance-evaluation operation failed.";
      await context.responses.error(message, "Memory evaluation");
    }
  }

  private async pending(context: CommandContext, guildId: string): Promise<void> {
    const trace = await this.collector.latestPending(guildId);
    if (!trace) {
      await context.responses.reply("There are no unreviewed retrieval samples for this server.");
      return;
    }
    const content = this.formatTrace(trace);
    if (trace.candidates.length <= 15) {
      await context.responses.reply(content);
      return;
    }
    await context.responses.reply({
      content,
      files: [{
        attachment: Buffer.from(`${JSON.stringify(trace, null, 2)}\n`, "utf8"),
        name: `memory-relevance-trace-${trace.id.slice(0, 8)}.json`,
      }],
    });
  }

  private async label(context: CommandContext, guildId: string): Promise<void> {
    const traceId = context.interaction.options.getString("trace", true);
    // Omitting "relevant" entirely is a legitimate label — "none of these
    // candidates were actually relevant" — not an error. Without it, the
    // dataset can never contain a false-positive-penalizing example (see
    // evaluateBm25Weights' precision calculation, which already handles an
    // empty relevant set correctly).
    const relevant = (context.interaction.options.getString("relevant", false) ?? "")
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    const splitValue = context.interaction.options.getString("split", true);
    if (splitValue !== "calibration" && splitValue !== "validation") {
      throw new Error("Split must be calibration or validation.");
    }
    const trace = await this.collector.label({
      guildId, traceId, relevantCandidateIds: relevant, split: splitValue,
    });
    await context.responses.reply(`Labeled trace \`${trace.id.slice(0, 8)}\` with ${relevant.length} relevant candidate(s).`);
  }

  private async skip(context: CommandContext, guildId: string): Promise<void> {
    const traceId = context.interaction.options.getString("trace", true);
    const trace = await this.collector.skip(guildId, traceId);
    await context.responses.reply(`Skipped trace \`${trace.id.slice(0, 8)}\`.`);
  }

  private async export(context: CommandContext, guildId: string): Promise<void> {
    const cases = await this.collector.exportCases(guildId);
    if (cases.length === 0) {
      await context.responses.reply("There are no labeled cases to export for this server.");
      return;
    }
    await context.responses.reply({
      content: `Exported ${cases.length} labeled memory-relevance case(s).`,
      files: [{
        attachment: Buffer.from(`${JSON.stringify(cases, null, 2)}\n`, "utf8"),
        name: `memory-relevance-${guildId}.json`,
      }],
    });
  }

  private formatTrace(trace: MemoryRelevanceTrace): string {
    const selected = new Set(trace.selectedIds);
    const candidateLines = trace.candidates.slice(0, 15).map((candidate) => {
      const marker = selected.has(candidate.id) ? "✓" : "·";
      const statement = candidate.statement.replaceAll("\n", " ").slice(0, 100);
      return `${marker} \`${candidate.id.slice(0, 8)}\` **${candidate.topic}.${candidate.slot}** ${statement}`;
    });
    const omitted = trace.candidates.length - candidateLines.length;
    return [
      `**Trace \`${trace.id.slice(0, 8)}\`**`,
      `Query: ${trace.message.slice(0, 300)}`,
      "✓ = selected by the bot",
      ...candidateLines,
      ...(omitted > 0 ? [`…and ${omitted} more candidates; export after labeling retains the full set.`] : []),
      "Use `/memory-eval label` with every candidate ID that should be relevant, or `/memory-eval skip`.",
    ].join("\n").slice(0, 2_000);
  }
}
