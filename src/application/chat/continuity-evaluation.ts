import { createHash } from "node:crypto";

import { z } from "zod";

import { chatInteractions, isExplicitInteraction, type ChatInteraction } from "./chat-policy.js";
import type { PriorAnswerAnchorMode } from "./prior-answer-anchor.js";

// Phase E continuity comparison: the same frozen multi-speaker cases, model and prompt budget under
// three ways of building a turn's history.
export const continuityVariants = ["current", "direct", "anchor"] as const;
export type ContinuityVariant = typeof continuityVariants[number];
export const continuityVariantSettings: Readonly<Record<ContinuityVariant, { readers: string; anchor: PriorAnswerAnchorMode; description: string }>> = {
  current: { readers: "", anchor: "off", description: "v1 proofs: an earlier reply carries every message it cited" },
  direct: { readers: "reply_part=v2,session=v2", anchor: "off", description: "graph ancestry: an earlier reply is one direct input" },
  anchor: { readers: "reply_part=v2,session=v2", anchor: "on", description: "graph ancestry plus the prior-answer anchor" },
};

export const continuityScenarios = ["cross_speaker_followup", "long_gap", "ambiguous_followup", "correction", "interleaved", "dense_history", "direct_mention",
  "optional_ignore", "implicit_followup"] as const;
const message = z.object({ id: z.string().regex(/^[a-z0-9]+$/u), speaker: z.string().min(1), text: z.string().min(1), replyTo: z.string().optional() }).strict();
const filler = z.object({ filler: z.number().int().min(1).max(80), askEvery: z.number().int().min(0) }).strict();
const caseSchema = z.object({
  id: z.string().regex(/^(?:en|zh)-[a-z0-9-]+$/u), language: z.enum(["en", "zh-TW"]), scenario: z.enum(continuityScenarios),
  lines: z.array(z.union([message, filler])).min(1),
  final: z.object({ speaker: z.string().min(1), text: z.string().min(1), interaction: z.enum(chatInteractions) }).strict(),
  labels: z.object({ action: z.enum(["reply", "ignore"]),
    required: z.object({ line: z.string(), any: z.array(z.string().min(1)).min(1) }).strict().nullable(),
    forbidden: z.array(z.string().min(1)).optional() }).strict(),
}).strict();
const fillerPool = z.object({ speakers: z.array(z.string().min(1)).min(1), chatter: z.array(z.string().min(1)).min(1),
  asks: z.array(z.tuple([z.string().min(1), z.string().min(1)])).min(1) }).strict();
const thresholds = z.object({
  anchor: z.object({ followUpScenarios: z.array(z.enum(continuityScenarios)).min(1), minUseGainPoints: z.number(), maxMissedIncrease: z.number().int(),
    maxFalseInterruptionIncrease: z.number().int(), maxP95LatencyIncreasePercent: z.number() }).strict(),
  direct: z.object({ maxUseLossPoints: z.number(), maxMissedIncrease: z.number().int() }).strict(),
}).strict();
export const continuityCaseFileSchema = z.object({ version: z.number().int().positive(), frozenAt: z.string(), note: z.string(), thresholds,
  fillers: z.object({ en: fillerPool, "zh-TW": fillerPool }).strict(), cases: z.array(caseSchema).min(1) }).strict()
  .superRefine((file, context) => {
    const ids = new Set<string>();
    for (const item of file.cases) {
      if (ids.has(item.id)) context.addIssue({ code: "custom", message: `duplicate case ${item.id}` }); ids.add(item.id);
      const lines = item.lines.filter((line): line is z.infer<typeof message> => "id" in line);
      const known = new Set<string>();
      for (const line of lines) {
        if (known.has(line.id)) context.addIssue({ code: "custom", message: `${item.id}: duplicate line ${line.id}` });
        if (line.replyTo && !known.has(line.replyTo)) context.addIssue({ code: "custom", message: `${item.id}: ${line.id} replies to an unknown or later line` });
        if (line.speaker === "bot" && !line.replyTo) context.addIssue({ code: "custom", message: `${item.id}: bot line ${line.id} must reply to a question` });
        known.add(line.id);
      }
      if (item.labels.required && !known.has(item.labels.required.line)) context.addIssue({ code: "custom", message: `${item.id}: required line is unknown` });
      if ((item.labels.action === "ignore") !== (item.scenario === "optional_ignore")) context.addIssue({ code: "custom", message: `${item.id}: only optional_ignore cases expect silence` });
    }
  });
export type ContinuityCaseFile = z.infer<typeof continuityCaseFileSchema>;
export type ContinuityCase = ContinuityCaseFile["cases"][number];

// The freeze hash covers everything that decides a score: cases, filler pools and thresholds.
export function continuityFreezeHash(file: ContinuityCaseFile): string {
  return createHash("sha256").update(JSON.stringify({ version: file.version, thresholds: file.thresholds, fillers: file.fillers, cases: file.cases })).digest("hex");
}

export const continuityBotId = "1000000000000000200";
const continuityStart = 1_793_000_000_000;
export interface ContinuityMessage { lineId: string | null; messageId: string; speaker: string; authorId: string; text: string; bot: boolean; replyTo: string | null; timestampMs: number }
export interface ExpandedContinuityCase { messages: ContinuityMessage[]; final: ContinuityMessage & { interaction: ChatInteraction }; lineMessageIds: ReadonlyMap<string, string> }

// A pseudonymous 18-digit Discord-style ID per speaker name.
export function continuitySpeakerId(name: string): string {
  if (name === "bot") return continuityBotId;
  const digits = BigInt(`0x${createHash("sha256").update(name).digest("hex").slice(0, 15)}`) % 10n ** 17n;
  return `2${digits.toString().padStart(17, "0")}`;
}

function seededRandom(seed: string): () => number {
  let state = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) >>> 0;
  return (): number => {
    state = state + 0x6d2b79f5 >>> 0; let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

// Lays a case out as channel messages: fixed lines in order, deterministic filler chatter from other
// speakers, and a generic question to the bot (with its fixed answer) every askEvery filler messages.
export function expandContinuityCase(file: ContinuityCaseFile, item: ContinuityCase): ExpandedContinuityCase {
  const pool = file.fillers[item.language]; const random = seededRandom(item.id);
  const messages: ContinuityMessage[] = []; const lineMessageIds = new Map<string, string>();
  const mention = (text: string): string => text.replaceAll("<@BOT>", `<@${continuityBotId}>`);
  let clock = continuityStart;
  const push = (entry: Omit<ContinuityMessage, "messageId" | "authorId" | "timestampMs">, gapMs: number): ContinuityMessage => {
    clock += gapMs;
    const event = { ...entry, text: mention(entry.text), messageId: `13${String(messages.length + 1).padStart(17, "0")}`, authorId: continuitySpeakerId(entry.speaker), timestampMs: clock };
    messages.push(event); return event;
  };
  for (const line of item.lines) {
    if ("id" in line) {
      const event = push({ lineId: line.id, speaker: line.speaker, text: line.text, bot: line.speaker === "bot", replyTo: line.replyTo ? lineMessageIds.get(line.replyTo)! : null }, 40_000);
      lineMessageIds.set(line.id, event.messageId); continue;
    }
    for (let index = 1; index <= line.filler; index++) {
      const speaker = pool.speakers[Math.floor(random() * pool.speakers.length)]!;
      if (line.askEvery > 0 && index % line.askEvery === 0) {
        const [question, answer] = pool.asks[Math.floor(random() * pool.asks.length)]!;
        const asked = push({ lineId: null, speaker, text: question, bot: false, replyTo: null }, 30_000);
        push({ lineId: null, speaker: "bot", text: answer, bot: true, replyTo: asked.messageId }, 5_000);
      } else push({ lineId: null, speaker, text: pool.chatter[Math.floor(random() * pool.chatter.length)]!, bot: false, replyTo: null }, 30_000);
    }
  }
  const final = push({ lineId: "final", speaker: item.final.speaker, text: item.final.text, bot: false, replyTo: null }, 60_000);
  messages.pop();
  return { messages, final: { ...final, interaction: item.final.interaction }, lineMessageIds };
}

export interface ContinuityRow {
  caseId: string; variant: ContinuityVariant; repeat: number; language: "en" | "zh-TW"; scenario: ContinuityCase["scenario"];
  interaction: ChatInteraction; expected: "reply" | "ignore"; action: "reply" | "ignore"; text: string;
  replyTargetMessageId: string | null; targetMessageId: string;
  // Whether the required earlier statement reached the model's context; null when no reply call ran.
  contextHasRequired: boolean | null; anchorAdded: number; latencyMs: number; failure: string | null;
}

const lower = (text: string): string => text.toLowerCase();
export function usesRequired(item: ContinuityCase, text: string): boolean | null {
  if (!item.labels.required) return null;
  const reply = lower(text);
  return item.labels.required.any.some((term) => reply.includes(lower(term))) && !(item.labels.forbidden ?? []).some((term) => reply.includes(lower(term)));
}

export interface ContinuityMetrics {
  rows: number; actionAccuracy: number; missedExplicit: number; explicitRequests: number; falseInterruptions: number; optionalSilences: number;
  targetAccuracy: number | null; requiredCases: number; requiredUse: number | null; contextAvailability: number | null;
  latencyP50Ms: number | null; latencyP95Ms: number | null; failures: number;
}
const rate = (hits: number, total: number): number | null => total ? hits / total : null;
function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
}
export function continuityMetrics(rows: readonly ContinuityRow[], cases: ReadonlyMap<string, ContinuityCase>): ContinuityMetrics {
  const explicit = rows.filter((row) => row.expected === "reply" && isExplicitInteraction(row.interaction));
  const optional = rows.filter((row) => row.expected === "ignore");
  const replied = rows.filter((row) => row.expected === "reply" && row.action === "reply");
  const required = rows.filter((row) => cases.get(row.caseId)!.labels.required);
  const withContext = required.filter((row) => row.contextHasRequired !== null);
  return {
    rows: rows.length, actionAccuracy: rate(rows.filter((row) => row.action === row.expected).length, rows.length) ?? 0,
    missedExplicit: explicit.filter((row) => row.action === "ignore").length, explicitRequests: explicit.length,
    falseInterruptions: optional.filter((row) => row.action === "reply").length, optionalSilences: optional.length,
    targetAccuracy: rate(replied.filter((row) => (row.replyTargetMessageId ?? row.targetMessageId) === row.targetMessageId).length, replied.length),
    // A required case the bot did not answer counts as not using the statement.
    requiredCases: required.length, requiredUse: rate(required.filter((row) => row.action === "reply" && usesRequired(cases.get(row.caseId)!, row.text) === true).length, required.length),
    contextAvailability: rate(withContext.filter((row) => row.contextHasRequired).length, withContext.length),
    latencyP50Ms: percentile(rows.filter((row) => !row.failure).map((row) => row.latencyMs), 0.5),
    latencyP95Ms: percentile(rows.filter((row) => !row.failure).map((row) => row.latencyMs), 0.95), failures: rows.filter((row) => row.failure).length,
  };
}

export interface ContinuityVerdict { keep: boolean; reasons: string[] }
// Applies the thresholds frozen with the cases. The anchor is kept only if it raises use of the
// required statement on follow-up cases by the declared margin without more missed requests, more
// interruptions or more latency than allowed.
export function continuityVerdicts(file: ContinuityCaseFile, rows: readonly ContinuityRow[]): { anchor: ContinuityVerdict; direct: ContinuityVerdict } {
  const cases = new Map(file.cases.map((item) => [item.id, item]));
  const of = (variant: ContinuityVariant, scenarios?: readonly string[]): ContinuityMetrics =>
    continuityMetrics(rows.filter((row) => row.variant === variant && (!scenarios || scenarios.includes(row.scenario))), cases);
  const points = (value: number | null): number => (value ?? 0) * 100;
  const { anchor: anchorLimits, direct: directLimits } = file.thresholds;
  const followUp = anchorLimits.followUpScenarios;
  const [direct, anchored, directAll, anchoredAll, current] = [of("direct", followUp), of("anchor", followUp), of("direct"), of("anchor"), of("current")];
  const anchorReasons: string[] = [];
  const gain = points(anchored.requiredUse) - points(direct.requiredUse);
  if (gain < anchorLimits.minUseGainPoints) anchorReasons.push(`follow-up use gain ${gain.toFixed(1)} points is below ${anchorLimits.minUseGainPoints}`);
  if (anchoredAll.missedExplicit - directAll.missedExplicit > anchorLimits.maxMissedIncrease) anchorReasons.push("more missed explicit requests");
  if (anchoredAll.falseInterruptions - directAll.falseInterruptions > anchorLimits.maxFalseInterruptionIncrease) anchorReasons.push("more false interruptions");
  if (directAll.latencyP95Ms && anchoredAll.latencyP95Ms && (anchoredAll.latencyP95Ms / directAll.latencyP95Ms - 1) * 100 > anchorLimits.maxP95LatencyIncreasePercent)
    anchorReasons.push(`p95 latency rose more than ${anchorLimits.maxP95LatencyIncreasePercent}%`);
  if (anchoredAll.failures) anchorReasons.push(`${anchoredAll.failures} failed runs`);
  const directReasons: string[] = [];
  const loss = points(current.requiredUse) - points(directAll.requiredUse);
  if (loss > directLimits.maxUseLossPoints) directReasons.push(`use fell ${loss.toFixed(1)} points against current history`);
  if (directAll.missedExplicit - current.missedExplicit > directLimits.maxMissedIncrease) directReasons.push("more missed explicit requests than current history");
  if (directAll.failures) directReasons.push(`${directAll.failures} failed runs`);
  return { anchor: { keep: !anchorReasons.length, reasons: anchorReasons }, direct: { keep: !directReasons.length, reasons: directReasons } };
}

// A review sheet for paired blind judgments: each case's three replies in a per-case shuffled order
// under neutral labels, with the key kept apart.
export function continuityBlindSheet(file: ContinuityCaseFile, rows: readonly ContinuityRow[], repeat = 1): {
  sheet: { caseId: string; context: string; final: string; replies: { label: string; text: string }[] }[]; key: Record<string, Record<string, ContinuityVariant>>;
} {
  const sheet: { caseId: string; context: string; final: string; replies: { label: string; text: string }[] }[] = []; const key: Record<string, Record<string, ContinuityVariant>> = {};
  for (const item of file.cases) {
    const chosen = continuityVariants.map((variant) => rows.find((row) => row.caseId === item.id && row.variant === variant && row.repeat === repeat)).filter((row) => row !== undefined);
    if (!chosen.length) continue;
    const random = seededRandom(`blind:${item.id}:${repeat}`);
    const order = chosen.map((row) => ({ row, sort: random() })).sort((left, right) => left.sort - right.sort).map((entry) => entry.row);
    const labels = ["A", "B", "C"];
    const required = item.labels.required ? item.lines.find((line) => "id" in line && line.id === item.labels.required!.line) : undefined;
    sheet.push({ caseId: item.id, context: required && "text" in required ? `Earlier: ${required.speaker}: ${required.text}` : "(no earlier statement required)",
      final: `${item.final.speaker}: ${item.final.text}`, replies: order.map((row, index) => ({ label: labels[index]!, text: row.action === "reply" ? row.text : "(no reply)" })) });
    key[item.id] = Object.fromEntries(order.map((row, index) => [labels[index]!, row.variant]));
  }
  return { sheet, key };
}

