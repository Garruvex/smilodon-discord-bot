import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { GuildConfiguration } from "../../config/guild-configuration.js";
import { diagnosticElapsed, emitChatDiagnostic, safeFailure, withDiagnosticScope, type DiagnosticLogger } from "./chat-diagnostics.js";

export function diagnosticBuildVersion(value = process.env.BUILD_SHA ?? process.env.GIT_SHA): string {
  return value && /^[\w.:-]{1,128}$/u.test(value) ? value : "unknown";
}

// Stable across property ordering; only the fingerprint leaves this boundary.
export function diagnosticPolicyVersion(profile: GuildConfiguration | null | undefined): string {
  if (!profile) return "unconfigured";
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
  return createHash("sha256").update(JSON.stringify(canonical({ features: profile.features, roles: profile.roles,
    channels: profile.channels, chat: profile.chat, character: profile.character }))).digest("hex").slice(0, 24);
}

type GatewayOutcome = "startup_gate" | "control_channel" | "dispatched" | "out_of_scope";
export async function traceGateway(logger: DiagnosticLogger, input: {
  guildId?: string | undefined; channelId: string; sourceMessageId: string;
  kind: "message_created" | "reaction_added"; policyVersion: string;
}, task: () => Promise<GatewayOutcome>): Promise<void> {
  await withDiagnosticScope({ operation: "gateway", ...input }, async () => {
    const started = performance.now();
    emitChatDiagnostic(logger, { event: "chat.gateway.received", kind: input.kind, buildVersion: diagnosticBuildVersion(), policyVersion: input.policyVersion });
    try {
      const outcome = await task();
      emitChatDiagnostic(logger, { event: "chat.gateway.completed", outcome, durationMs: diagnosticElapsed(started) });
    } catch (error) {
      emitChatDiagnostic(logger, { event: "chat.gateway.completed", outcome: "failed", durationMs: diagnosticElapsed(started), ...safeFailure(error, "operation_error") });
      throw error;
    }
  });
}
