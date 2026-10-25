import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pino from "pino";
import { contextualReplayCases } from "../application/chat/contextual-replay.js";
import { contextualReplayPolicyRevision, replayPolicyAssessment } from "../application/chat/contextual-replay-policy.js";
import { contextualReplayAcceptance, contextualReplayThresholds } from "../application/chat/contextual-replay-acceptance.js";
import { contextualDecisionProviders } from "../application/chat/contextual-decision-providers.js";
import { CharacterDecisionService, contextualDecisionPromptRevision } from "../application/chat/character-decision.js";
import type { DecisionOutcome, NativeDecisionConfidence } from "../application/chat/character-decision.js";
import { contextualDecisionWireRevision } from "../application/chat/contextual-decision-contract.js";
import { nativeContextualAdapterRevision } from "../application/chat/native-contextual-decision.js";
import { safeFailure } from "../application/diagnostics/chat-diagnostics.js";
import { loadInstanceEnvironment } from "../config/instance-environment.js";
import { loadConfiguration } from "../config/environment.js";
import { createChatProviderFromConfig } from "../bootstrap/dependencies.js";
import { approveDecisionInput } from "../application/context/approved-decision-input.js";
import { guardModelTransport } from "../application/context/guarded-model-transport.js";
import { syntheticReplayContext } from "../application/chat/synthetic-replay-context.js";
import { GuardedConversationContext } from "../application/chat/guarded-conversation-context.js";
import { HttpDecisionProvider } from "../infrastructure/chat/http-decision-provider.js";
import { OpenAiNativeDecisionProvider } from "../infrastructure/chat/openai-native-decision-provider.js";
import type { StructuredCharacterProvider } from "../application/chat/chat-provider.js";

const args = process.argv.slice(2);
function argument(name: string): string | undefined { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
async function main(): Promise<void> {
  if (args.includes("--help")) {
    process.stdout.write("Usage: npm run eval:contextual -- [--live --instance pinecone] [--native-decisions] [--provider-role decision|reply|utility] [--scenario unknown] [--language en] [--limit 216] [--concurrency 2] [--output report.json]\nDefault: inventory only, no provider calls or Discord sends. --native-decisions requires live decision role and forces native /decisions for this replay only, without changing instance files or allowing generative fallback. --check-config reports credential presence only. Other live decision runs use the production contextual selector.\n"); return;
  }
  const limit = Number(argument("--limit") ?? 216); const concurrency = Number(argument("--concurrency") ?? 2);
  if (!Number.isInteger(limit) || limit < 1 || limit > 216 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("Invalid replay limits");
  const scenario = argument("--scenario"); const language = argument("--language");
  const inventory = contextualReplayCases();
  if (scenario && !inventory.some((item) => item.scenario === scenario) || language && !inventory.some((item) => item.language === language)) throw new Error("Unknown replay filter");
  const cases = inventory.filter((item) => (!scenario || item.scenario === scenario) && (!language || item.language === language)).slice(0, limit);
  const live = args.includes("--live"); const check = args.includes("--check-config");
  const providerRole = argument("--provider-role") ?? "decision";
  const nativeOnly = args.includes("--native-decisions");
  if (nativeOnly && (!live || check || providerRole !== "decision")) throw new Error("Native replay requires --live and decision role");
  if (!["decision", "reply", "utility"].includes(providerRole)) throw new Error("Invalid provider role");
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
  let providerSource: string | null = null;
  if (live) {
    const config = loadConfiguration(nativeOnly ? { ...environment!, DECISION_MODE: "decisions", DECISION_MODEL: "gpt-6-luna" } : environment!); const utilityConfig = config.utilityChat ?? config.chat;
    const logger = pino({ level: "silent" });
    const utility = utilityConfig ? createChatProviderFromConfig(utilityConfig, logger) : null;
    const reply = config.chat === utilityConfig ? utility : config.chat ? createChatProviderFromConfig(config.chat, logger) : null;
    const structuredReply = reply?.generateCharacterData ? { generateCharacterData: reply.generateCharacterData.bind(reply) } : null;
    const structuredUtility = utility?.generateCharacterData ? { generateCharacterData: utility.generateCharacterData.bind(utility) } : null;
    const dedicated = config.decision ? guardModelTransport(config.decision.mode === "decisions" ? new OpenAiNativeDecisionProvider(config.decision) : new HttpDecisionProvider(config.decision)) : null;
    const selected = contextualDecisionProviders(dedicated, structuredReply, structuredUtility);
    primary = providerRole === "decision" ? selected.primary : providerRole === "reply" ? structuredReply : structuredUtility;
    fallback = providerRole === "decision" ? selected.fallback : null;
    providerSource = providerRole === "decision" ? selected.source : providerRole;
    const selectedConfig = providerSource === "reply" ? config.chat : utilityConfig;
    const selectedModels = providerSource === "reply" || !config.utilityChat ? config.chat?.summaryModels ?? [] : utilityConfig?.models ?? [];
    providerIdentity = providerSource === "dedicated" && config.decision ? { provider: config.decision.mode === "decisions" ? "openai-decisions" : "openai-compatible", models: [config.decision.model], reasoningEffort: null } : selectedConfig ?
      { provider: selectedConfig.provider, models: selectedModels, reasoningEffort: selectedConfig.provider === "openai-responses" ? selectedConfig.reasoningEffort : null } : null;
    if (!primary) throw new Error("No configured structured provider");
    if (nativeOnly && (primary.decisionProtocol !== "openai-decisions" || fallback || providerIdentity?.provider !== "openai-decisions")) throw new Error("Native endpoint selection failed");
  }
  const results: { id: string; language: string; scenario: string; status: string; durationMs: number; relationship: string | null; intent: string | null;
    action: string | null; referent: string | null; expectedMeaning: boolean | null; failures: string[]; policy: Awaited<ReturnType<typeof replayPolicyAssessment>> | null;
    confidence: number | null; recipientConfidence: number | null; linkKind: string | null; evidenceCount: number;
    nativeConfidence?: NativeDecisionConfidence;
    review?: { conversation: typeof cases[number]["events"]; expectedRelationships: readonly string[]; textAllowed: boolean;
      decision: DecisionOutcome["decision"]; generatedReply: null };
    tokens?: { input: number; output: number; cached: number; reasoning: number; measuredAttempts: number; modelAttempts: number } }[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: live ? concurrency : 1 }, async () => {
    while (cursor < cases.length) {
      const fixture = cases[cursor++]!;
      if (!live) { results.push({ id: fixture.id, language: fixture.language, scenario: fixture.scenario, status: "not_run", durationMs: 0, relationship: null, intent: null, action: null, referent: null, expectedMeaning: null, failures: [], policy: null, confidence: null, recipientConfidence: null, linkKind: null, evidenceCount: 0 }); continue; }
      const started = Date.now();
      const service = new CharacterDecisionService(primary, fallback);
      const { port, botId } = await syntheticReplayContext(fixture);
      const lease = await GuardedConversationContext.open(port, { count: 40, budget: 12000, burstIds: [fixture.current.messageId] });
      const input = approveDecisionInput({ contextual: true, useContextBoundary: false, sourceContext: lease,
        personality: "A fictional Discord bot named Pinecone. Use the language of the current speaker.",
        events: lease.history, burst: lease.burst, botId, fixedTarget: lease.current.messageId,
        canUseContext: (): Promise<boolean> => lease.validate(),
        ...(probeMs === null ? {} : { signal: AbortSignal.timeout(probeMs) }),
        gapMs: 60000, speakingShare: 0, thoughts: false });
      const result: DecisionOutcome = await service.evaluate(input);
      const interpretation = result.decision?.contextual;
      const durationMs = Date.now() - started;
      const policy = await replayPolicyAssessment(fixture, result);
      results.push({ id: fixture.id, language: fixture.language, scenario: fixture.scenario, status: result.status, durationMs, policy,
        review: { conversation: [...fixture.events, fixture.current], expectedRelationships: fixture.expectedRelationships,
          textAllowed: fixture.textAllowed, decision: result.decision, generatedReply: null },
        tokens: { input: result.attempts.reduce((total, item) => total + (item.inputTokens ?? 0), 0), output: result.attempts.reduce((total, item) => total + (item.outputTokens ?? 0), 0),
          cached: result.attempts.reduce((total, item) => total + (item.cachedInputTokens ?? 0), 0), reasoning: result.attempts.reduce((total, item) => total + (item.reasoningTokens ?? 0), 0),
          measuredAttempts: result.attempts.filter((item) => item.inputTokens !== undefined).length, modelAttempts: result.attempts.filter((item) => item.stage === "model").length },
        confidence: result.decision?.confidence ?? null, recipientConfidence: result.decision?.recipientConfidence ?? null,
        ...(result.decision?.nativeConfidence ? { nativeConfidence: result.decision.nativeConfidence } : {}),
        linkKind: interpretation?.link?.kind ?? null, evidenceCount: result.decision?.recipientEvidence.length ?? 0,
        relationship: interpretation?.relationship ?? null, intent: interpretation?.intent ?? null, action: interpretation?.action ?? null, referent: interpretation?.referent ?? null,
        expectedMeaning: interpretation ? fixture.expectedRelationships.includes(interpretation.relationship) && (fixture.textAllowed || interpretation.action !== "reply") : false,
        failures: result.attempts.flatMap((attempt) => attempt.failure ? [attempt.failure] : []) });
    }
  }));
  const valid = results.filter((result) => result.status === "valid").length;
  const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
  const acceptance = live && probeMs === null ? contextualReplayAcceptance(results) : null;
  const summary = { mode: probeMs !== null ? "live_latency_probe" : live ? "live_synthetic_decision_replay" : "fixture_inventory_only", fixtureRevision: 3, wireRevision: contextualDecisionWireRevision, promptRevision: contextualDecisionPromptRevision, policyRevision: contextualReplayPolicyRevision, providerRoutingRevision: 2, providerRole, providerSource, providerIdentity, nativeOnly,
    ...(primary?.decisionProtocol === "openai-decisions" ? { nativeAdapterRevision: nativeContextualAdapterRevision } : {}),
    probeTimeoutMs: probeMs, cases: cases.length, valid: live ? valid : null,
    filters: { scenario: scenario ?? null, language: language ?? null },
    expectedMeaning: live ? results.filter((result) => result.expectedMeaning).length : null,
    meaningMetric: "Relationship label correct AND no forbidden text-reply proposal. Does not measure generated reply quality.",
    correctRelationships: live ? results.filter((result) => result.relationship !== null && result.review?.expectedRelationships.includes(result.relationship)).length : null,
    forbiddenReplyProposals: live ? results.filter((result) => result.action === "reply" && result.review?.textAllowed === false).length : null,
    generatedReplies: 0,
    policyTextViolations: live ? results.filter((result) => result.policy && !result.policy.textPolicyMet).length : null,
    policyRequiredReplyMisses: live ? results.filter((result) => result.policy && !result.policy.requiredReplyMet).length : null,
    policyRejections: live ? Object.fromEntries([...new Set(results.filter((result) => result.policy?.status === "denied" || result.policy?.status === "failed").map((result) => result.policy!.reason))]
      .map((reason) => [reason, results.filter((result) => result.policy?.reason === reason).length])) : null,
    policyScope: "Actual preflight engine with a synthetic authorized lease and both action budgets available; excludes scheduling, generation and delivery. Provider failures are reported separately from abstention.",
    p50Ms: live ? durations[Math.floor(durations.length * 0.5)] : null, p95Ms: live ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : null,
    validityGateMet: live && probeMs === null && cases.length >= 200 ? valid / cases.length >= 0.99 : null,
    acceptanceThresholds: contextualReplayThresholds, acceptance,
    semanticReview: "Controlled expected-label checks; independent review and a scoped live pilot remain required.",
    tokenUsage: live ? results.reduce((total, item) => ({ input: total.input + (item.tokens?.input ?? 0), output: total.output + (item.tokens?.output ?? 0),
      cached: total.cached + (item.tokens?.cached ?? 0), reasoning: total.reasoning + (item.tokens?.reasoning ?? 0), measuredAttempts: total.measuredAttempts + (item.tokens?.measuredAttempts ?? 0),
      modelAttempts: total.modelAttempts + (item.tokens?.modelAttempts ?? 0) }), { input: 0, output: 0, cached: 0, reasoning: 0, measuredAttempts: 0, modelAttempts: 0 }) : null,
    monetaryCost: "Not estimated: apply the configured provider's actual rates; aborted/unreported usage may be missing.", discordSends: 0 };
  const output = resolve(argument("--output") ?? "contextual-participation-replay.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ summary, results: results.sort((a, b) => a.id.localeCompare(b.id)) }, null, 2), "utf8");
  process.stdout.write(JSON.stringify({ ...summary, output }) + "\n");
  if (live && acceptance && !acceptance.passed) process.exitCode = 2;
}
void main().catch((error: unknown) => { process.stderr.write(JSON.stringify({ status: "failed", ...safeFailure(error, "operation_error") }) + "\n"); process.exitCode = 1; });
