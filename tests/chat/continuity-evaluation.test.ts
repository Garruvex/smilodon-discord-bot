import { readFileSync } from "node:fs";

import pino from "pino";
import { describe, expect, it } from "vitest";

import {
  continuityBlindSheet, continuityCaseFileSchema, continuityFreezeHash, continuityMetrics, continuityVariants, continuityVerdicts, expandContinuityCase, usesRequired,
  type ContinuityCaseFile, type ContinuityRow, type ContinuityVariant,
} from "../../src/application/chat/continuity-evaluation.js";
import { loadFrozenCases, offlineBaselineOf, offlinePersona, runContinuityCase, scriptedReply } from "../../src/scripts/replay-continuity-runner.js";

const file = continuityCaseFileSchema.parse(JSON.parse(readFileSync("tests/fixtures/continuity/cases.json", "utf8")) as unknown);
const baseline = JSON.parse(readFileSync("tests/fixtures/continuity/offline-baseline.json", "utf8")) as { sha256: string; rows: Record<string, unknown> };
const cases = new Map(file.cases.map((item) => [item.id, item]));

function row(caseId: string, variant: ContinuityVariant, patch: Partial<ContinuityRow> = {}): ContinuityRow {
  const item = cases.get(caseId)!;
  return { caseId, variant, repeat: 1, language: item.language, scenario: item.scenario, interaction: item.final.interaction, expected: item.labels.action,
    action: item.labels.action, text: item.labels.required?.any[0] ?? "hi", replyTargetMessageId: null, targetMessageId: "final", contextHasRequired: true, anchorAdded: 0,
    latencyMs: 1_000, failure: null, ...patch };
}

describe("continuity evaluation set (E1)", () => {
  it("is frozen: the cases, fillers and thresholds match the recorded hash", async () => {
    const freeze = JSON.parse(readFileSync("tests/fixtures/continuity/freeze.json", "utf8")) as { sha256: string; cases: number };
    expect(continuityFreezeHash(file)).toBe(freeze.sha256);
    expect(baseline.sha256).toBe(freeze.sha256);
    expect(file.cases).toHaveLength(freeze.cases);
    await expect(loadFrozenCases()).resolves.toBeDefined();
    const edited: ContinuityCaseFile = { ...file, cases: [{ ...file.cases[0]!, final: { ...file.cases[0]!.final, text: "changed" } }, ...file.cases.slice(1)] };
    expect(continuityFreezeHash(edited)).not.toBe(freeze.sha256);
  });

  it("balances languages and covers every labelled scenario", () => {
    expect(file.cases.filter((item) => item.language === "en")).toHaveLength(20);
    expect(file.cases.filter((item) => item.language === "zh-TW")).toHaveLength(20);
    expect(new Set(file.cases.map((item) => item.scenario))).toEqual(new Set(["cross_speaker_followup", "long_gap", "ambiguous_followup", "correction", "interleaved",
      "dense_history", "direct_mention", "optional_ignore", "implicit_followup"]));
    // Each scenario's cases mirror across the two languages.
    for (const scenario of new Set(file.cases.map((item) => item.scenario)))
      expect(file.cases.filter((item) => item.scenario === scenario && item.language === "en")).toHaveLength(file.cases.filter((item) => item.scenario === scenario && item.language === "zh-TW").length);
  });

  it("rejects a case whose labels do not fit its lines", () => {
    const broken = structuredClone(file);
    broken.cases[0]!.labels.required = { line: "missing", any: ["x"] };
    expect(continuityCaseFileSchema.safeParse(broken).success).toBe(false);
    const silentReply = structuredClone(file);
    silentReply.cases[0]!.labels.action = "ignore";
    expect(continuityCaseFileSchema.safeParse(silentReply).success).toBe(false);
  });

  it("expands a case deterministically with the bot's fixed answers replying to their questions", () => {
    const item = cases.get("en-cross-ramen")!;
    const first = expandContinuityCase(file, item); const second = expandContinuityCase(file, item);
    expect(second).toEqual(first);
    const answer = first.messages.find((message) => message.lineId === "a")!;
    expect(answer).toMatchObject({ bot: true, replyTo: first.lineMessageIds.get("q") });
    expect(first.messages.filter((message) => !message.bot && message.lineId === null)).toHaveLength(46);
    // Every fourth filler message here is a generic question with its own fixed answer.
    expect(first.messages.filter((message) => message.bot && message.lineId === null)).toHaveLength(4);
    expect(first.final).toMatchObject({ interaction: "direct_mention", timestampMs: expect.any(Number) as number });
    expect(first.final.text).toContain("<@1000000000000000200>");
    expect(first.final.timestampMs).toBeGreaterThan(first.messages.at(-1)!.timestampMs);
  });
});

describe("continuity scoring (E2)", () => {
  it("counts a statement as used only with a required term and no forbidden one", () => {
    const item = cases.get("en-correction")!;
    expect(usesRequired(item, "It's on Monday now.")).toBe(true);
    expect(usesRequired(item, "Monday? I thought Thursday.")).toBe(false);
    expect(usesRequired(cases.get("en-control-mention")!, "anything")).toBeNull();
  });

  it("scores missed requests, interruptions, required use and latency per variant", () => {
    const rows = [
      row("en-cross-ramen", "direct", { text: "no idea", contextHasRequired: false, latencyMs: 900 }),
      row("en-cross-ramen", "anchor", { text: "Ichiran!", latencyMs: 1_000 }),
      row("en-ignore-group", "anchor", { action: "reply", text: "hi" }),
      row("en-control-mention", "anchor", { action: "ignore", text: "" }),
    ];
    const anchored = continuityMetrics(rows.filter((entry) => entry.variant === "anchor"), cases);
    expect(anchored).toMatchObject({ rows: 3, missedExplicit: 1, explicitRequests: 2, falseInterruptions: 1, optionalSilences: 1, requiredCases: 1, requiredUse: 1, contextAvailability: 1 });
    expect(anchored.actionAccuracy).toBeCloseTo(1 / 3);
    expect(continuityMetrics(rows.filter((entry) => entry.variant === "direct"), cases)).toMatchObject({ requiredUse: 0, contextAvailability: 0, latencyP95Ms: 900 });
  });

  it("keeps the anchor only when follow-ups gain by the frozen margin without costs", () => {
    const followUps = file.cases.filter((item) => file.thresholds.anchor.followUpScenarios.includes(item.scenario));
    const all = (variant: ContinuityVariant, use: (index: number) => boolean, latencyMs = 1_000): ContinuityRow[] =>
      file.cases.map((item, index) => row(item.id, variant, { text: use(index) || !followUps.includes(item) ? item.labels.required?.any[0] ?? "hi" : "no idea", latencyMs }));
    const winning = [...all("current", () => false), ...all("direct", () => false), ...all("anchor", () => true)];
    expect(continuityVerdicts(file, winning).anchor).toEqual({ keep: true, reasons: [] });
    const slow = [...all("current", () => false), ...all("direct", () => false), ...all("anchor", () => true, 2_000)];
    expect(continuityVerdicts(file, slow).anchor.keep).toBe(false);
    const flat = [...all("current", () => true), ...all("direct", () => true), ...all("anchor", () => true)];
    expect(continuityVerdicts(file, flat).anchor.reasons[0]).toMatch(/below 10/u);
    expect(continuityVerdicts(file, flat).direct.keep).toBe(true);
  });

  it("builds a blind sheet whose labels hide the variants and whose key restores them", () => {
    const rows = continuityVariants.map((variant) => row("en-cross-ramen", variant, { text: `${variant} reply` }));
    const { sheet, key } = continuityBlindSheet(file, rows);
    expect(sheet).toHaveLength(1);
    expect(sheet[0]!.replies.map((reply) => reply.label)).toEqual(["A", "B", "C"]);
    expect(JSON.stringify(sheet)).not.toMatch(/"(?:current|direct|anchor)"/u);
    for (const reply of sheet[0]!.replies) expect(reply.text).toBe(`${key["en-cross-ramen"]![reply.label]!} reply`);
  });
});

describe("continuity replay through the conversation service", () => {
  const providers = { reply: scriptedReply, utility: scriptedReply };
  const play = (caseId: string, variant: ContinuityVariant): ReturnType<typeof runContinuityCase> =>
    runContinuityCase({ file, item: cases.get(caseId)!, variant, repeat: 1, providers, personality: offlinePersona, logger: pino({ level: "silent" }) });

  it("gives only the anchor variant the earlier answer a cross-speaker follow-up needs", async () => {
    const [current, direct, anchor] = await Promise.all([play("en-cross-ramen", "current"), play("en-cross-ramen", "direct"), play("en-cross-ramen", "anchor")]);
    expect([current.contextHasRequired, direct.contextHasRequired, anchor.contextHasRequired]).toEqual([false, false, true]);
    expect(anchor.coverage).toMatchObject({ anchor: 2, anchorMatch: "beyond" });
    expect(anchor.request!.channelHistory[0]!.content).toContain("<@1000000000000000200> any good ramen");
    // Earlier answers seeded through the service are real, verifiable bot replies under every variant.
    for (const result of [current, direct, anchor]) expect(result.coverage).toMatchObject({ unverifiedBot: 0, invalidatedDerived: 0 });
  }, 60_000);

  it("adds nothing when the answer is still in the window, and reproduces the frozen offline baseline", async () => {
    const rows = await Promise.all((["en-ambiguous-window", "zh-cross-ramen", "zh-dense-bot"] as const).flatMap((caseId) => continuityVariants.map((variant) => play(caseId, variant))));
    expect(rows.filter((result) => result.caseId === "en-ambiguous-window").map((result) => result.anchorAdded)).toEqual([0, 0, 0]);
    const reproduced = offlineBaselineOf(rows);
    for (const [key, value] of Object.entries(reproduced)) expect(value).toEqual(baseline.rows[key]);
  }, 120_000);
});
