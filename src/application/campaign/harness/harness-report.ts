import type { CampaignEvent } from "../../../domain/campaign/events/campaign-event.js";
import { encounterRecords, type EncounterRecord } from "../dm/combat-records.js";
import { describeBeat } from "../dm/llm-dm.js";
import { roundRecords } from "../dm/round-records.js";
import type { HarnessRun, ModelCall } from "./campaign-harness.js";

export interface HarnessReport {
  readonly roundsPlayed: number;
  readonly quietRounds: number;
  readonly stoppedBecause: HarnessRun["stoppedBecause"];
  readonly perHero: readonly { readonly name: string; readonly actions: number; readonly passes: number; readonly misses: number }[];
  readonly checks: { readonly total: number; readonly successes: number; readonly timedOut: number };
  readonly moments: Readonly<Record<string, number>>;
  readonly narration: { readonly count: number; readonly lengths: readonly number[]; readonly unit: "words" | "characters" };
  readonly plannerFailures: number;
  readonly fights: readonly {
    readonly id: string;
    readonly outcome: string;
    readonly rounds: number;
    readonly flourishes: number;
    // Hero drops to 0 HP over the fight.
    readonly heroesDowned: number;
  }[];
  readonly latency: Readonly<Record<ModelCall["call"], { readonly p50: number; readonly p95: number; readonly calls: number }>>;
  readonly maxContextTokens: number;
  readonly usage: Readonly<Record<ModelCall["call"], TokenTotals>>;
  readonly models: readonly string[];
  readonly promptVersions: readonly string[];
  // Null when no prices were given or no call reported usage.
  readonly cost: { readonly total: number; readonly perRound: number; readonly perLiveHour: number } | null;
  // Exact secret text found in anything the Narrator received or wrote.
  readonly leaks: readonly string[];
  // zh-TW only: Simplified-only characters found in narration.
  readonly simplifiedCharacters: readonly string[];
}

// Characters that exist only in Simplified Chinese. Conservative on purpose:
// characters shared with Traditional usage are left out (斗 stays out: 斗篷 is
// Traditional), so a hit is a real drift.
const simplifiedOnly = new Set(
  "这们说过还进对时会个为学发与问门马见长开关头书东车国边让从气乐实现点应经没样专业电话饭钱铁银错间闻听语谁请读写买卖卫报场张强总战声画区医岁归兴举级极杀际陈陆阴阳龙鸟鱼觉认识钟仅决刘纪约红细终织给绝统续罗脑药虽询贵费资赵选遗邮释钥锁队阶险随难饮馆驾验鲁鲜".split(""),
);

export interface TokenTotals {
  readonly calls: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

// USD per million tokens, for the model used in the run.
export interface TokenPricing {
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
}

// Plan §6: a Live session plays about 20-30 exploration rounds an hour.
export const liveRoundsPerHour = 25;

export function summarizeRun(run: HarnessRun, pricing?: TokenPricing): HarnessReport {
  const events = run.events.map((envelope) => envelope.event);
  const rounds = playedRounds(events);
  const names = run.finalState.characters;
  const nameOf = (id: string): string => names[id]?.name ?? id;

  const perHero = run.players.map((player) => ({
    name: nameOf(player.heroId),
    actions: rounds.filter((round) => round.actions.has(player.heroId)).length,
    passes: rounds.filter((round) => round.passed.has(player.heroId)).length,
    misses: rounds.filter((round) => round.missed.has(player.heroId)).length,
  }));

  const resolved = events.filter((event): event is Extract<CampaignEvent, { kind: "checkResolved" }> => event.kind === "checkResolved");
  const timedOut = events.filter((event) => event.kind === "checkRollStarted" && event.timedOut).length;
  const moments: Record<string, number> = {};
  for (const event of resolved) {
    const headline = event.result.moments.headline;
    if (headline !== null) moments[headline.kind] = (moments[headline.kind] ?? 0) + 1;
  }

  const narrations = events.flatMap((event) =>
    event.kind === "narrationRecorded" || event.kind === "combatNarrationRecorded" ? [event.text] : [],
  );
  const fights = fightsOf(run).map((fight) => ({
    id: fight.id,
    outcome: fight.outcome ?? "unfinished",
    rounds: fight.rounds.length,
    flourishes: fight.rounds.filter((round) => round.narration !== null).length + (fight.closing === null ? 0 : 1),
    heroesDowned: fight.rounds
      .flatMap((round) => round.beats)
      .flatMap((beat) => (beat.kind === "action" ? beat.targets : []))
      .filter((target) => target.condition === "unconscious" && heroNames(run).has(target.name)).length,
  }));
  const zh = run.language === "zh-TW";
  const lengths = narrations.map((text) => (zh ? [...text.replace(/\s/g, "")].length : text.split(/\s+/).filter(Boolean).length));

  const secrets = secretTexts(run);
  const exposed = [JSON.stringify(run.narratorRequests), JSON.stringify(run.combatNarratorRequests), ...narrations].join("\n");
  const leaks = secrets.filter((secret) => exposed.includes(secret));
  const simplifiedCharacters = zh ? [...new Set([...narrations.join("")].filter((character) => simplifiedOnly.has(character)))] : [];

  return {
    roundsPlayed: rounds.length,
    quietRounds: events.filter((event) => event.kind === "roundResolved" && event.quiet).length,
    stoppedBecause: run.stoppedBecause,
    perHero,
    checks: { total: resolved.length, successes: resolved.filter((event) => event.result.success).length, timedOut },
    moments,
    narration: { count: narrations.length, lengths, unit: zh ? "characters" : "words" },
    plannerFailures: events.filter((event) => event.kind === "plannerFailed").length,
    fights,
    latency: { planner: latencyOf(run.calls, "planner"), narrator: latencyOf(run.calls, "narrator"), flourish: latencyOf(run.calls, "flourish") },
    maxContextTokens: Math.max(0, ...run.calls.map((call) => call.contextTokens)),
    usage: { planner: tokenTotals(run.calls, "planner"), narrator: tokenTotals(run.calls, "narrator"), flourish: tokenTotals(run.calls, "flourish") },
    models: [...new Set(run.calls.flatMap((call) => (call.model === null ? [] : [call.model])))],
    promptVersions: [...new Set(run.calls.flatMap((call) => (call.promptVersion === null ? [] : [call.promptVersion])))],
    cost: costOf(run.calls, pricing, rounds.length),
    leaks,
    simplifiedCharacters,
  };
}

export function renderReport(run: HarnessRun, report: HarnessReport): string {
  const lines: string[] = [];
  const bible = run.adventure.bible;
  lines.push(`# Harness run: ${bible.title} (${run.language})`, "");
  lines.push(`Rounds played: ${report.roundsPlayed} (quiet: ${report.quietRounds}); stopped: ${report.stoppedBecause}.`, "");
  lines.push("## Spotlight", "", "| Hero | Actions | Passes | Missed |", "| --- | --- | --- | --- |");
  for (const hero of report.perHero) lines.push(`| ${hero.name} | ${hero.actions} | ${hero.passes} | ${hero.misses} |`);
  lines.push("", "## Checks and moments", "");
  lines.push(`${report.checks.total} checks, ${report.checks.successes} succeeded, ${report.checks.timedOut} auto-rolled on timeout.`);
  const moments = Object.entries(report.moments).map(([kind, count]) => `${kind} ×${count}`);
  lines.push(`Headline moments: ${moments.length > 0 ? moments.join(", ") : "none"}.`, "");
  lines.push("## DM calls", "");
  lines.push(`Planner failures: ${report.plannerFailures}. Largest context: ~${report.maxContextTokens} tokens.`);
  for (const [call, stats] of Object.entries(report.latency)) {
    lines.push(`${call}: ${stats.calls} calls, p50 ${stats.p50.toFixed(0)} ms, p95 ${stats.p95.toFixed(0)} ms.`);
  }
  for (const [call, totals] of Object.entries(report.usage)) {
    if (totals.calls === 0) continue;
    const cached = totals.inputTokens === 0 ? 0 : (100 * totals.cachedInputTokens) / totals.inputTokens;
    lines.push(
      `${call} tokens: ${totals.inputTokens} in (${cached.toFixed(0)}% cached), ${totals.outputTokens} out over ${totals.calls} calls.`,
    );
  }
  if (report.models.length > 0) lines.push(`Models: ${report.models.join(", ")}; prompts: ${report.promptVersions.join(", ")}.`);
  if (report.cost !== null) {
    lines.push(
      `Estimated cost: ${report.cost.total.toFixed(4)} for this run, ${report.cost.perRound.toFixed(4)} per round, about ${report.cost.perLiveHour.toFixed(2)} per Live hour (${liveRoundsPerHour} rounds).`,
    );
  }
  for (const fight of report.fights) {
    lines.push(
      `Fight ${fight.id}: ${fight.outcome} in ${fight.rounds} round(s), ${fight.flourishes} narrated passage(s), heroes downed ${fight.heroesDowned} time(s).`,
    );
  }
  const { lengths, unit } = report.narration;
  const average = lengths.length === 0 ? 0 : lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  lines.push(`Narration: ${report.narration.count} passages, average ${average.toFixed(0)} ${unit}, longest ${Math.max(0, ...lengths)}.`, "");
  lines.push("## Checks against the plan", "");
  lines.push(report.leaks.length === 0 ? "- Secret leak scan: clean." : `- Secret leak scan: **${report.leaks.length} leaked**: ${report.leaks.join(" | ")}`);
  if (run.language === "zh-TW") {
    lines.push(
      report.simplifiedCharacters.length === 0
        ? "- Simplified-character scan: clean."
        : `- Simplified-character scan: **found ${report.simplifiedCharacters.join("")}**`,
    );
  }
  lines.push("", "## Transcript", "");
  lines.push(...transcript(run));
  return lines.join("\n");
}

function transcript(run: HarnessRun): string[] {
  const events = run.events.map((envelope) => envelope.event);
  const fights = fightsOf(run);
  const nameOf = (id: string): string => run.finalState.characters[id]?.name ?? id;
  const lines: string[] = [];
  for (const round of playedRounds(events)) {
    lines.push(`### Round ${round.number}`, "");
    for (const [heroId, text] of round.actions) {
      const resolution = round.resolutions[heroId];
      let result = "";
      if (resolution?.kind === "check") {
        const check = round.checks.get(resolution.checkId);
        const roll = check?.result;
        if (check !== undefined && roll != null) {
          const headline = roll.moments.headline === null ? "" : ` · ${roll.moments.headline.kind}`;
          result = ` → d20 ${roll.roll.d20.natural}, total ${roll.roll.total} vs DC ${check.dc}: ${roll.success ? "success" : "failure"}${headline}`;
        }
      } else if (resolution !== undefined) {
        result = ` → ${resolution.kind}`;
      }
      lines.push(`- **${nameOf(heroId)}**: ${text}${result}`);
    }
    for (const heroId of round.passed) lines.push(`- **${nameOf(heroId)}** passes.`);
    for (const heroId of round.missed) lines.push(`- **${nameOf(heroId)}** did not respond.`);
    if (round.narration !== null) lines.push("", `> ${round.narration}`);
    lines.push("");
    for (const fight of fights.filter((candidate) => candidate.afterRound === round.number)) lines.push(...fightTranscript(fight));
  }
  return lines;
}

function fightTranscript(fight: EncounterRecord): string[] {
  const lines = [`#### Fight ${fight.id} (${fight.outcome ?? "unfinished"})`, ""];
  for (const round of fight.rounds) {
    lines.push(`Combat round ${round.round}:`, "");
    for (const beat of round.beats) lines.push(`- ${describeBeat(beat)}`);
    if (round.narration !== null) lines.push("", `> ${round.narration}`);
    lines.push("");
  }
  if (fight.closing !== null) lines.push(`> ${fight.closing}`, "");
  return lines;
}

function fightsOf(run: HarnessRun): readonly EncounterRecord[] {
  const events = run.events.map((envelope) => envelope.event);
  return encounterRecords(events, { state: run.finalState, bible: run.adventure.bible, glossary: run.glossary });
}

function heroNames(run: HarnessRun): ReadonlySet<string> {
  return new Set(Object.values(run.finalState.characters).map((sheet) => sheet.name));
}

// Rounds that closed; the round opened after the last narration is still empty.
function playedRounds(events: readonly CampaignEvent[]): ReturnType<typeof roundRecords> {
  const closed = new Set(events.flatMap((event) => (event.kind === "roundClosed" ? [event.roundNumber] : [])));
  return roundRecords(events).filter((round) => closed.has(round.number));
}

function secretTexts(run: HarnessRun): readonly string[] {
  const bible = run.adventure.bible;
  const ledgerSecrets = Object.values(run.finalState.ledger).flatMap((entry) =>
    entry.facts.filter((fact) => fact.visibility === "secret").map((fact) => fact.text),
  );
  return [
    bible.dmOverview,
    ...bible.scenes.map((scene) => scene.dmNotes),
    ...bible.npcs.map((npc) => npc.secret),
    ...bible.encounters.map((encounter) => encounter.dmNotes),
    ...ledgerSecrets,
  ];
}

function tokenTotals(calls: readonly ModelCall[], call: ModelCall["call"]): TokenTotals {
  const withUsage = calls.filter((entry) => entry.call === call && entry.usage !== null);
  return {
    calls: withUsage.length,
    inputTokens: withUsage.reduce((sum, entry) => sum + (entry.usage?.inputTokens ?? 0), 0),
    cachedInputTokens: withUsage.reduce((sum, entry) => sum + (entry.usage?.cachedInputTokens ?? 0), 0),
    outputTokens: withUsage.reduce((sum, entry) => sum + (entry.usage?.outputTokens ?? 0), 0),
  };
}

function costOf(calls: readonly ModelCall[], pricing: TokenPricing | undefined, roundsPlayed: number): HarnessReport["cost"] {
  const withUsage = calls.flatMap((entry) => (entry.usage === null ? [] : [entry.usage]));
  if (pricing === undefined || withUsage.length === 0 || roundsPlayed === 0) return null;
  const total = withUsage.reduce((sum, usage) => {
    const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
    return sum + (uncached * pricing.input + usage.cachedInputTokens * pricing.cachedInput + usage.outputTokens * pricing.output) / 1_000_000;
  }, 0);
  const perRound = total / roundsPlayed;
  return { total, perRound, perLiveHour: perRound * liveRoundsPerHour };
}

function latencyOf(calls: readonly ModelCall[], call: ModelCall["call"]): { p50: number; p95: number; calls: number } {
  const durations = calls
    .filter((entry) => entry.call === call)
    .map((entry) => entry.milliseconds)
    .sort((a, b) => a - b);
  const at = (quantile: number): number => durations[Math.min(durations.length - 1, Math.floor(quantile * durations.length))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), calls: durations.length };
}
