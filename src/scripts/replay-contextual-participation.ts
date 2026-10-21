import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pino from "pino";
import { contextualReplayCases } from "../application/chat/contextual-replay.js";
import { contextualReplayPolicyRevision, replayPolicyAssessment } from "../application/chat/contextual-replay-policy.js";
import { CharacterDecisionService } from "../application/chat/character-decision.js";
import type { DecisionOutcome } from "../application/chat/character-decision.js";
import { contextualDecisionContract, contextualDecisionWireRevision, ContextualContractError } from "../application/chat/contextual-decision-contract.js";
import { safeFailure } from "../application/diagnostics/chat-diagnostics.js";
import { loadInstanceEnvironment } from "../config/instance-environment.js";
import { loadConfiguration } from "../config/environment.js";
import { createChatProviderFromConfig } from "../bootstrap/dependencies.js";
import { HttpDecisionProvider } from "../infrastructure/chat/http-decision-provider.js";
import type { StructuredCharacterProvider } from "../application/chat/chat-provider.js";

const args = process.argv.slice(2);
function argument(name: string): string | undefined { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
async function main(): Promise<void> {
  if (args.includes("--help")) {
    process.stdout.write("Usage: npm run eval:contextual -- [--live --instance pinecone] [--scenario unknown] [--language en] [--limit 216] [--concurrency 2] [--output report.json]\nDefault: inventory only, no provider calls or Discord sends. --check-config reports credential presence only. Live mode evaluates synthetic conversations and writes content-free proposal and policy results.\n"); return;
  }
  const limit = Number(argument("--limit") ?? 216); const concurrency = Number(argument("--concurrency") ?? 2);
  if (!Number.isInteger(limit) || limit < 1 || limit > 216 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("Invalid replay limits");
  const scenario = argument("--scenario"); const language = argument("--language");
  const inventory = contextualReplayCases();
  if (scenario && !inventory.some((item) => item.scenario === scenario) || language && !inventory.some((item) => item.language === language)) throw new Error("Unknown replay filter");
  const cases = inventory.filter((item) => (!scenario || item.scenario === scenario) && (!language || item.language === language)).slice(0, limit);
  const live = args.includes("--live"); const check = args.includes("--check-config");
  const probeMs = argument("--probe-timeout-ms") === undefined ? null : Number(argument("--probe-timeout-ms"));
  if (probeMs !== null && (!live || limit > 3 || !Number.isInteger(probeMs) || probeMs < 1000 || probeMs > 20000)) throw new Error("Latency probes require live mode, at most three cases, and a 1–20 second timeout");
  const instance = argument("--instance");
  if ((live || check) && !instance) throw new Error("An explicit instance is required");
  const environment = instance ? loadInstanceEnvironment(instance).environment : null;
  if (check) {
    process.stdout.write(JSON.stringify({ instance, decisionConfigured: !!environment?.DECISION_MODEL, utilityConfigured: !!environment?.UTILITY_MODEL, utilityModel: environment?.UTILITY_MODEL ?? null,
      openaiKeyAvailable: !!environment?.OPENAI_API_KEY, decisionKeyAvailable: !!environment?.DECISION_API_KEY, googleKeyAvailable: !!environment?.GOOGLE_API_KEY }) + "\n"); return;
  }
  let primary: StructuredCharacterProvider | null = null; let fallback: StructuredCharacterProvider | null = null;
  let providerIdentity: { provider: string; models: readonly string[]; reasoningEffort: string | null } | null = null;
  if (live) {
    const config = loadConfiguration(environment!); const utilityConfig = config.utilityChat ?? config.chat;
    const utility = utilityConfig ? createChatProviderFromConfig(utilityConfig, pino({ level: "silent" })) : null;
    fallback = utility?.generateCharacterData ? { generateCharacterData: utility.generateCharacterData.bind(utility) } : null;
    primary = config.decision ? new HttpDecisionProvider(config.decision) : fallback;
    providerIdentity = config.decision ? { provider: "openai-compatible", models: [config.decision.model], reasoningEffort: null } : utilityConfig ?
      { provider: utilityConfig.provider, models: utilityConfig.models, reasoningEffort: utilityConfig.provider === "openai-responses" ? utilityConfig.reasoningEffort : null } : null;
    if (!primary) throw new Error("No configured structured provider");
  }
  const results: { id: string; language: string; scenario: string; status: string; durationMs: number; relationship: string | null; intent: string | null;
    action: string | null; referent: string | null; expectedMeaning: boolean | null; failures: string[]; policy: Awaited<ReturnType<typeof replayPolicyAssessment>> | null }[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: live ? concurrency : 1 }, async () => {
    while (cursor < cases.length) {
      const fixture = cases[cursor++]!;
      if (!live) { results.push({ id: fixture.id, language: fixture.language, scenario: fixture.scenario, status: "not_run", durationMs: 0, relationship: null, intent: null, action: null, referent: null, expectedMeaning: null, failures: [], policy: null }); continue; }
      const started = Date.now();
      const service = new CharacterDecisionService(primary, fallback);
      let provider = primary;
      if (probeMs !== null) provider = { generateCharacterData: async (prompt, schema): Promise<unknown> => primary!.generateCharacterData(prompt, schema, { signal: AbortSignal.timeout(probeMs), maxAttempts: 1 }) };
      const input = { contextual: true, useContextBoundary: false, personality: "A fictional Discord bot named Pinecone. Use the language of the current speaker.",
        events: fixture.events, burst: [fixture.current], botId: "1000000000000000200", fixedTarget: fixture.current.messageId,
        gapMs: 60000, speakingShare: 0, thoughts: false };
      let result: DecisionOutcome;
      if (probeMs === null) result = await service.evaluate(input);
      else {
        const contract = contextualDecisionContract([...fixture.events, fixture.current], input.botId, fixture.current.messageId);
        let wirePrompt = ""; let wireSchema: Record<string, unknown> = {};
        await new CharacterDecisionService({ generateCharacterData: (prompt, schema): Promise<unknown> => {
          wirePrompt = prompt; wireSchema = schema; return Promise.reject(new Error("Capture synthetic wire contract"));
        } }).evaluate(input);
        try {
          const raw = await provider!.generateCharacterData(wirePrompt, wireSchema);
          result = { status: "valid", decision: contract.parse(raw), attempts: [] };
        } catch (error) { result = { status: "failed", decision: null, attempts: [{ providerRole: "primary", attempt: 1, status: "failed", durationMs: Date.now() - started,
          ...(error instanceof ContextualContractError ? { failure: error.failure } : safeFailure(error)) }] }; }
      }
      const interpretation = result.decision?.contextual;
      const durationMs = Date.now() - started;
      const policy = await replayPolicyAssessment(fixture, result);
      results.push({ id: fixture.id, language: fixture.language, scenario: fixture.scenario, status: result.status, durationMs, policy,
        relationship: interpretation?.relationship ?? null, intent: interpretation?.intent ?? null, action: interpretation?.action ?? null, referent: interpretation?.referent ?? null,
        expectedMeaning: interpretation ? fixture.expectedRelationships.includes(interpretation.relationship) && (fixture.textAllowed || interpretation.action !== "reply") : false,
        failures: result.attempts.flatMap((attempt) => attempt.failure ? [attempt.failure] : []) });
    }
  }));
  const valid = results.filter((result) => result.status === "valid").length;
  const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
  const summary = { mode: probeMs !== null ? "live_latency_probe" : live ? "live_synthetic_decision_replay" : "fixture_inventory_only", fixtureRevision: 2, wireRevision: contextualDecisionWireRevision, policyRevision: contextualReplayPolicyRevision, providerIdentity, probeTimeoutMs: probeMs, cases: cases.length, valid: live ? valid : null,
    filters: { scenario: scenario ?? null, language: language ?? null },
    expectedMeaning: live ? results.filter((result) => result.expectedMeaning).length : null,
    policyTextViolations: live ? results.filter((result) => result.policy && !result.policy.textPolicyMet).length : null,
    policyRequiredReplyMisses: live ? results.filter((result) => result.policy && !result.policy.requiredReplyMet).length : null,
    policyScope: "Actual preflight engine with a synthetic authorized lease and both action budgets available; excludes scheduling, generation and delivery. Provider failures are reported separately from abstention.",
    p50Ms: live ? durations[Math.floor(durations.length * 0.5)] : null, p95Ms: live ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : null,
    validityGateMet: live && probeMs === null && cases.length >= 200 ? valid / cases.length >= 0.99 : null,
    semanticReview: "Controlled expected-label checks; independent review and a scoped live pilot remain required.", tokenUsage: "unavailable", discordSends: 0 };
  const output = resolve(argument("--output") ?? "contextual-participation-replay.json");
  await writeFile(output, JSON.stringify({ summary, results: results.sort((a, b) => a.id.localeCompare(b.id)) }, null, 2), "utf8");
  process.stdout.write(JSON.stringify({ ...summary, output }) + "\n");
  if (live && summary.validityGateMet === false && cases.length >= 200) process.exitCode = 2;
}
void main().catch((error: unknown) => { process.stderr.write(JSON.stringify({ status: "failed", ...safeFailure(error, "operation_error") }) + "\n"); process.exitCode = 1; });
