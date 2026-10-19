import { PermissionFlagsBits } from "discord.js";
import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import type { ChatTraceStore, RetainedChatTrace } from "../../../../application/diagnostics/chat-trace-store.js";
import type { DiagnosticPipelineStatus } from "../../../../application/diagnostics/chat-diagnostics.js";
import type { DecisionHealth } from "../../../../application/chat/character-decision.js";
import type { GenerationHealth } from "../../../../application/diagnostics/model-diagnostics.js";
import { explainChatTrace } from "../../../../application/diagnostics/chat-explanation.js";
import { renderChatExplanation } from "../../../../application/i18n/chat-explanation.js";
import type { Language } from "../../../../application/i18n/language.js";

function messageInChannel(value: string, guildId: string, channelId: string): string | null {
  if (/^\d{17,20}$/u.test(value)) return value;
  const link = /^https:\/\/(?:(?:canary|ptb)\.)?discord\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?$/u.exec(value);
  return link && link[1] === guildId && link[2] === channelId ? link[3]! : null;
}

function timeline(trace: RetainedChatTrace, groups: number): string {
  const lines = trace.records.slice(-16).map((record) => {
    const event = record.data;
    const details = ["outcome" in event ? event.outcome : null, "action" in event ? event.action : null,
      "status" in event ? event.status : null, "reason" in event ? event.reason : null,
      "failure" in event ? event.failure : null, "selected" in event ? `selected=${event.selected}` : null,
      "deliveredParts" in event ? `parts=${event.deliveredParts}/${event.plannedParts}` : null].filter(Boolean).join(" / ");
    return `${new Date(record.timestampMs).toISOString().slice(11, 23)} ${event.event}${details ? `: ${details}` : ""}`;
  });
  const selected: string[] = [];
  let size = 0;
  for (const line of [...lines].reverse()) {
    if (size + line.length + 1 > 900) break;
    selected.unshift(line); size += line.length + 1;
  }
  return [`Trace ${trace.traceId} (UTC; latest of ${groups} retained source groups)`,
    ...(trace.truncated || trace.records.length > selected.length ? ["Partial timeline: older events were omitted or evicted."] : []), ...selected].join("\n");
}

export class DiagnosticCommand implements BotCommand {
  public readonly definition = {
    name: "diagnostic",
    description: "Displays owner-only runtime diagnostics.",
    options: [{ type: "string", name: "message", description: "Explain a message ID or link in this channel.", required: false, maxLength: 150 },
      { type: "boolean", name: "decision", description: "Run a cached synthetic decision-provider health check.", required: false }],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Diagnostics;
  public readonly access = {
    ...publicAccessPolicy,
    ownerOnly: true,
  };
  public readonly responseVisibility = CommandResponseVisibility.Ephemeral;

  public constructor(private readonly traces: ChatTraceStore | null = null, private readonly ownerUserIds: ReadonlySet<string> | null = null,
    private readonly pipelineStatus: (() => Readonly<DiagnosticPipelineStatus>) | null = null,
    private providerHealth: { decision: () => DecisionHealth | null; generation: () => Readonly<GenerationHealth>; checkDecision: () => Promise<DecisionHealth | null> } | null = null,
    private readonly language: (guildId: string | null) => Language = () => "en") {}
  public bindProviderHealth(health: NonNullable<DiagnosticCommand["providerHealth"]>): void { this.providerHealth = health; }

  public async execute(context: CommandContext): Promise<void> {
    if (this.ownerUserIds && !this.ownerUserIds.has(context.interaction.user.id)) {
      await context.responses.reply("Only a bot owner can inspect diagnostics."); return;
    }
    if (context.interaction.options.getBoolean?.("decision")) {
      await context.responses.defer();
      try {
        const health = await this.providerHealth?.checkDecision();
        await context.responses.edit(health ? `Decision providers configured: ${health.configured}; cooling down: ${health.coolingDownProviders}; last valid decision: ${health.lastSuccessAt === null ? "none observed" : new Date(health.lastSuccessAt).toISOString()}; last failure: ${health.lastFailureAt === null ? "none observed" : new Date(health.lastFailureAt).toISOString()}. Synthetic checks are cached for 60 seconds.` : "Decision-provider health checks are unavailable.");
      } catch { await context.responses.edit("The synthetic decision health check failed; no conversation content was used."); }
      return;
    }
    const reference = context.interaction.options.getString("message");
    if (reference !== null) {
      const { guildId, channelId, guild } = context.interaction;
      if (!guildId || !channelId || !guild) { await context.responses.reply("Trace lookup only works in a server channel."); return; }
      const messageId = messageInChannel(reference.trim(), guildId, channelId);
      if (!messageId) { await context.responses.reply("Use a message ID or a Discord message link from this server and channel."); return; }
      await context.responses.defer();
      try {
        // Re-resolve current permissions. An owner interaction bypass is not
        // authorization to inspect a hidden or no-longer-readable channel.
        const [channel, member, bot] = await Promise.all([
          guild.channels.fetch(channelId, { force: true }),
          guild.members.fetch({ user: context.interaction.user.id, force: true }),
          guild.members.fetchMe({ force: true }),
        ]);
        const permissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
        if (!channel?.permissionsFor(member)?.has(permissions) || !channel.permissionsFor(bot)?.has(permissions)) {
          await context.responses.edit("Trace lookup requires current channel and history access for both you and the bot."); return;
        }
      } catch {
        await context.responses.edit("Current channel access could not be verified; no diagnostic records were read."); return;
      }
      if (!this.traces) { await context.responses.edit("Diagnostic retention is not available on this instance."); return; }
      const traces = this.traces.lookup({ guildId, channelId, sourceMessageId: messageId });
      const explanation = explainChatTrace(traces);
      await context.responses.edit([renderChatExplanation(explanation, this.language(guildId)),
        ...(explanation.trace ? [timeline(explanation.trace, traces.length)] : [])].join("\n"));
      return;
    }
    const memoryUsageMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const uptimeSeconds = Math.round(process.uptime());
    const retention = this.traces?.status();
    const pipeline = this.pipelineStatus?.();
    const decision = this.providerHealth?.decision(); const generation = this.providerHealth?.generation();

    await context.responses.reply({
      content: [
        `Uptime: ${uptimeSeconds} seconds`,
        `Resident memory: ${memoryUsageMb} MB`,
        `Guilds: ${context.interaction.client.guilds.cache.size}`,
        ...(retention ? [`Retained diagnostic events: ${retention.events}; dropped traces/events: ${retention.droppedTraces}/${retention.droppedEvents}; write failures: ${retention.writeFailures}`] : []),
        ...(pipeline ? [`Diagnostic attempts: ${pipeline.attempted}; invalid: ${pipeline.invalidEvents}; log-only: ${pipeline.unscopedEvents}; retention/log exceptions: ${pipeline.retentionFailures}/${pipeline.logFailures}`] : []),
        ...(decision ? [`Decision providers configured: ${decision.configured}; cooling down: ${decision.coolingDownProviders}; last valid result: ${decision.lastSuccessAt === null ? "none observed" : new Date(decision.lastSuccessAt).toISOString()}`] : []),
        ...(generation ? [`Observed reply calls completed/failed: ${generation.completed}/${generation.failed}`] : []),
      ].join("\n"),
    });
  }
}
