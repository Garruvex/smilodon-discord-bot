import type { AuditLogService } from "../../../../../application/audit/audit-log-service.js";
import type { ReadOnlySettingDefinition } from "./setting-definition.js";

export async function formatAuditSummary(
  auditLogService: AuditLogService | undefined,
  guildId: string,
  count: number,
): Promise<string> {
  if (!auditLogService) return "Audit logging isn't available right now.";
  const result = await auditLogService.fetchRecent(guildId, count);
  if (!result.configured) {
    return "No audit log channel is configured. Set one with `/settings access audit-log channel:<channel>`.";
  }
  if (result.entries.length === 0) {
    return "No audit log entries found yet.";
  }
  const lines = result.entries.map((entry) => {
    const oneLine = entry.description.replaceAll("\n", " · ");
    return `<t:${Math.floor(entry.createdAt / 1_000)}:R> ${oneLine}`;
  });
  return ["Recent audit log entries:", ...lines].join("\n").slice(0, 2_000);
}

export const auditSetting: ReadOnlySettingDefinition = {
  kind: "readOnly",
  name: "audit",
  description: "Shows recent settings/setup change log entries.",
  configureOptions: () => [
    { type: "integer", name: "count", description: "How many recent entries to show (default 10).", minValue: 1, maxValue: 20 },
  ],
  run: (context, deps) => formatAuditSummary(
    deps.auditLogService,
    context.interaction.guildId!,
    context.interaction.options.getInteger("count") ?? 10,
  ),
};
