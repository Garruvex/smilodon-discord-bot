import { describe, expect, it } from "vitest";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import { diagnosticBuildVersion, diagnosticPolicyVersion, traceGateway } from "../../src/application/diagnostics/gateway-diagnostics.js";
import { emitChatDiagnostic, withDiagnosticScope } from "../../src/application/diagnostics/chat-diagnostics.js";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";

const input = { guildId: "guild", channelId: "channel", sourceMessageId: "source", kind: "message_created" as const, policyVersion: "policy" };
describe("gateway diagnostics", () => {
  it.each(["startup_gate", "control_channel", "dispatched", "out_of_scope"] as const)("records %s with one terminal event", async (outcome) => {
    const { logger, records } = captureDiagnosticLogger();
    await traceGateway(logger, input, () => Promise.resolve(outcome));
    expect(records.map((record) => record.event)).toEqual(["chat.gateway.received", "chat.gateway.completed"]);
    expect(records[1]).toMatchObject({ traceId: records[0]!.traceId, outcome });
  });
  it("links dispatch children and preserves a safe failure", async () => {
    const { logger, records } = captureDiagnosticLogger();
    const error = new Error("SECRET");
    await expect(traceGateway(logger, input, async () => {
      await Promise.resolve();
      withDiagnosticScope({ operation: "dispatch", ...input }, () => emitChatDiagnostic(logger, { event: "chat.ingress.received", kind: "message_created" }));
      throw error;
    })).rejects.toBe(error);
    expect(new Set(records.map((record) => record.traceId)).size).toBe(1);
    expect(records[1]!.parentSpanId).toBe(records[0]!.spanId);
    expect(records[2]).toMatchObject({ outcome: "failed", failure: "operation_error" });
    expect(JSON.stringify(records)).not.toContain("SECRET");
  });
  it("fingerprints effective policy stably without serializing its contents", () => {
    const profile = { chat: { secretText: "SECRET", enabled: true }, features: { chatbot: true } } as unknown as GuildConfiguration;
    const reordered = { features: { chatbot: true }, chat: { enabled: true, secretText: "SECRET" } } as unknown as GuildConfiguration;
    expect(diagnosticPolicyVersion(profile)).toBe(diagnosticPolicyVersion(reordered));
    expect(diagnosticPolicyVersion(profile)).not.toBe(diagnosticPolicyVersion({ ...profile, features: { ...profile.features, chatbot: false } }));
    expect(diagnosticPolicyVersion(profile)).toMatch(/^[a-f0-9]{24}$/u);
    expect(diagnosticBuildVersion("unsafe build\nsecret")).toBe("unknown");
    expect(diagnosticBuildVersion("abc123")).toBe("abc123");
  });
});
