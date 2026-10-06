import type { CampaignCommand, RecordLedgerFactCommand } from "../commands/campaign-command.js";
import { isLedgerEntityId } from "../ledger/ledger.js";
import { beginEncounter } from "./combat/combat-flow.js";
import type { Decision } from "./decision.js";
import { maxNarrationLength } from "./narration-limits.js";
import type { Rejection } from "./rejection.js";
import { finishReadyCheck, openRound } from "./rounds.js";

export const maxLedgerFactLength = 300;
export const maxSummaryLength = 1_500;
export const maxSceneNoteLength = 400;
export const sceneNoteCompactionThreshold = 1_600;
// Kept as a compatibility export; compaction is triggered by note size now.
export const chronicleEveryRounds = 6;

// Numbers such as hit points, slots and gold change all the time; a summary
// that states them would go stale and contradict the live state.
const vitalNumbers = /\b\d+\s*(?:hp|hit points?|hit dice|slots?|gp|gold|coins?)\b|\b(?:hp|gold|slots?)\s*[:=]?\s*\d+|\d+\s*(?:點生命|生命值?|金幣|法術位)/i;

export function latestSummaryRound(summaries: readonly { readonly throughRound: number; readonly visibility: string }[] | undefined, visibility: "public" | "private"): number {
  return (summaries ?? []).filter((summary) => summary.visibility === visibility).reduce((latest, summary) => Math.max(latest, summary.throughRound), 0);
}

// The Planner failed validation twice: hold the round with a neutral line
// and tell the organizer. Submissions are kept for a retry.
export function reportPlannerFailure(decision: Decision, roundNumber: number, problems: readonly string[]): Rejection | null {
  if (decision.ctx.actor.kind !== "system") return { code: "systemOnly" };
  const round = decision.state.round;
  if (round?.status !== "planning" || round.number !== roundNumber) return { code: "notPlanning" };
  decision.emit({ kind: "plannerFailed", roundNumber, problems });
  decision.request({ kind: "deliver", delivery: { kind: "dmHolding", roundNumber } });
  decision.request({ kind: "deliver", delivery: { kind: "organizerNotice", notice: "plannerFailed", roundNumber } });
  return null;
}

export function retryPlan(decision: Decision): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user" || ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (state.status === "waitingForPlayers") return { code: "campaignWaiting" };
  if (state.round?.status !== "planning") return { code: "notPlanning" };
  decision.emit({ kind: "planRetryRequested", roundNumber: state.round.number });
  decision.request({ kind: "plan", roundNumber: state.round.number });
  return null;
}

// The game has started: ask the Narrator for the opening scene. Nothing else
// happens until it is told, so no round timer runs while the table reads. A
// game that already has a round (or an opening) is left as it is, which also
// makes a restart's second attempt harmless.
export function beginAdventure(decision: Decision): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "system") return { code: "systemOnly" };
  if (state.opening !== undefined || state.lastRoundNumber > 0 || state.round !== null) return null;
  decision.emit({ kind: "adventureBegan" });
  if (state.visits === undefined && state.sceneId !== null) decision.emit({ kind: "sceneVisitStarted", sceneId: state.sceneId, roundNumber: 1 });
  decision.request({ kind: "narrateOpening" });
  return null;
}

// Saves the opening. The first round opens once every present player has
// pressed Ready (or the organizer starts it), so nobody misses the scene.
export function recordOpening(decision: Decision, text: string): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "system") return { code: "systemOnly" };
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > maxNarrationLength) return { code: "emptyNarration" };
  if (state.opening !== "pending") return { code: "staleNarration" };
  decision.emit({ kind: "openingRecorded", text: trimmed });
  decision.request({ kind: "deliver", delivery: { kind: "opening" } });
  // Establish the place the players just heard about. Hero portraits already
  // belong on the Party cards, so they do not interrupt the opening narration.
  if (state.sceneId !== null) decision.request({ kind: "sceneImage", sceneId: state.sceneId, roundNumber: 0, snapshot: decision.pictureSnapshot() });
  if (decision.state.status === "active") finishReadyCheck(decision);
  return null;
}

// A present player is ready for round 1.
export function markReady(decision: Decision): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user") return { code: "notMember" };
  const member = state.members[ctx.actor.userId];
  if (member === undefined) return { code: "notMember" };
  if (member.availability === "away") return { code: "memberAway" };
  if (state.status === "waitingForPlayers") return { code: "campaignWaiting" };
  if (state.opening !== "waiting") return { code: "notAwaitingReady" };
  if (!(state.openingReady ?? []).includes(member.userId)) decision.emit({ kind: "memberReadied", userId: member.userId });
  finishReadyCheck(decision);
  return null;
}

// The organizer does not wait for the rest of the table.
export function beginPlay(decision: Decision): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user" || ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (state.status === "waitingForPlayers") return { code: "campaignWaiting" };
  if (state.opening !== "waiting") return { code: "notAwaitingReady" };
  decision.emit({ kind: "tableReady" });
  openRound(decision, { skipActorCheck: true });
  return null;
}

// Saves the Narrator's text for a resolved round, then starts the fight the
// round queued, or opens the next round, if anyone is present. Narration
// that arrives while the table is waiting is still kept; the next step waits
// for continue.
export function recordNarration(decision: Decision, roundNumber: number, text: string, note?: string): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "system") return { code: "systemOnly" };
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > maxNarrationLength) return { code: "emptyNarration" };
  if (state.round !== null || state.lastRoundNumber !== roundNumber || state.lastNarratedRound >= roundNumber) {
    return { code: "staleNarration" };
  }
  decision.emit({ kind: "narrationRecorded", roundNumber, text: trimmed });
  const sceneId = decision.state.visits?.findLast((visit) => visit.arrivedRound <= roundNumber && (visit.leftRound === undefined || visit.leftRound >= roundNumber))?.sceneId ?? decision.state.sceneId;
  const noteLines = (note ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 2);
  if (sceneId !== null && noteLines.length > 0) {
    noteLines.forEach((line, noteIndex) => decision.emit({ kind: "sceneNoteProposed", roundNumber, sceneId, noteIndex, text: line.slice(0, maxSceneNoteLength) }));
    decision.request({ kind: "judgeSceneNotes", roundNumber, sceneId });
  }
  decision.request({ kind: "deliver", delivery: { kind: "narration", roundNumber } });
  // A natural 20 or 1 in the round is a moment worth a picture (the worker rations these).
  const dramatic = Object.values(state.checks).some((check) => check.roundNumber === roundNumber && (check.result?.moments.headline?.kind === "natural20" || check.result?.moments.headline?.kind === "natural1"));
  if (dramatic) decision.request({ kind: "momentImage", roundNumber, auto: true, snapshot: decision.pictureSnapshot() });
  // Keep private, secret-bearing story memory when a chapter closes. Public
  // summaries are now per-scene and compact only when that scene's notes grow large.
  if (state.sceneChangedRound === roundNumber) decision.request({ kind: "chronicle", throughRound: roundNumber, privateOnly: true });
  if (decision.state.status !== "active") return null;
  const pending = decision.state.pendingEncounter;
  if (pending !== null) {
    beginEncounter(decision, pending);
    return null;
  }
  return openRound(decision);
}

export function reviewSceneNotes(decision: Decision, command: Extract<CampaignCommand, { kind: "reviewSceneNotes" }>): Rejection | null {
  if (decision.ctx.actor.kind !== "system") return { code: "systemOnly" };
  const pending = (decision.state.pendingSceneNotes ?? []).filter((note) => note.roundNumber === command.roundNumber && note.sceneId === command.sceneId);
  if (pending.length === 0) return { code: "staleSummary" };
  const results = new Map(command.results.map((result) => [result.noteIndex, result]));
  if (command.results.length !== pending.length || new Set(command.results.map((result) => result.noteIndex)).size !== command.results.length || command.results.some((result) => !pending.some((note) => note.noteIndex === result.noteIndex))) return { code: "staleSummary" };
  for (const note of pending) {
    const result = results.get(note.noteIndex);
    let outcome: "keep" | "reword" | "drop" = result?.decision ?? "drop";
    let text = outcome === "keep" ? note.text : (result?.text ?? "").trim();
    const reason = (result?.reason ?? "No valid judge result; note discarded.").trim().slice(0, 240);
    const hasUnknownIds = /\bscene:[a-z0-9:_-]+/i.test(text);
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (outcome !== "drop" && (text.length === 0 || text.length > maxSceneNoteLength || lines.length > 2 || hasUnknownIds)) outcome = "drop";
    if (outcome === "reword" && result?.decision !== "reword") outcome = "drop";
    text = outcome === "keep" ? note.text : lines.slice(0, 2).map((line) => line.slice(0, maxSceneNoteLength)).join("\n");
    decision.emit({ kind: "sceneNoteReviewed", roundNumber: command.roundNumber, sceneId: command.sceneId, noteIndex: note.noteIndex, decision: outcome, text, reason });
  }
  const characters = (decision.state.sceneNotes ?? []).filter((note) => note.sceneId === command.sceneId).reduce((sum, note) => sum + note.text.length, 0);
  if (characters >= sceneNoteCompactionThreshold) decision.request({ kind: "compactSceneNotes", sceneId: command.sceneId, throughRound: command.roundNumber });
  return null;
}

// The organizer asks for the last narration to be told again. It changes no
// state: no dice, no resources, no story effects (those were fixed before the
// words), and only the round just narrated may be retold.
export function regenerateNarration(decision: Decision, roundNumber: number): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user" || ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (roundNumber !== state.lastNarratedRound || roundNumber < 1) return { code: "nothingToRetell" };
  decision.request({ kind: "renarrate", roundNumber });
  return null;
}

// The organizer asks for a picture of the last told round. It changes no state;
// the picture is made in the background from the narration the table already read.
export function illustrateMoment(decision: Decision, roundNumber: number): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user" || ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (roundNumber !== state.lastNarratedRound || roundNumber < 1) return { code: "nothingToIllustrate" };
  decision.request({ kind: "momentImage", roundNumber, snapshot: decision.pictureSnapshot() });
  return null;
}

// The organizer corrects the story's day, time or weather. The event records that it was a correction (and why), and the history before it stays.
export function correctWorld(decision: Decision, command: Extract<CampaignCommand, { kind: "setWorld" }>): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user" || ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  const change = { kind: "set", ...(command.day === undefined ? {} : { day: command.day }), ...(command.time === undefined ? {} : { time: command.time }), ...(command.weather === undefined ? {} : { weather: command.weather }) } as const;
  const problem = decision.worldProblem(change);
  if (problem !== null) return { code: "invalidPlan", problems: [problem] };
  decision.changeWorld(state.lastRoundNumber, change, "correction", command.note);
  return null;
}

export function redoPicture(decision: Decision, subject: string): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user" || ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (subject.length === 0) return { code: "nothingToRedo" };
  decision.request({ kind: "redoImage", subject });
  return null;
}

// The retold words replace the earlier ones for that round; nothing else moves.
export function replaceNarration(decision: Decision, roundNumber: number, text: string): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "system") return { code: "systemOnly" };
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > maxNarrationLength) return { code: "emptyNarration" };
  if (roundNumber !== state.lastNarratedRound) return { code: "staleNarration" };
  decision.emit({ kind: "narrationRecorded", roundNumber, text: trimmed });
  decision.request({ kind: "deliver", delivery: { kind: "narration", roundNumber, regenerated: true } });
  return null;
}

// Keeps the Chronicler's summary of the rounds through `throughRound`. A late
// one, made before newer rounds were summarized, is refused rather than
// overwriting what is already there; a summary stating hit points, slots or
// gold is refused because those come from live state only.
export function recordSummary(decision: Decision, command: Extract<CampaignCommand, { kind: "recordSummary" }>): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "system") return { code: "systemOnly" };
  const text = command.text.trim();
  if (text.length === 0 || text.length > maxSummaryLength) return { code: "invalidSummary", problem: "text" };
  if (vitalNumbers.test(text)) return { code: "invalidSummary", problem: "numbers" };
  if (!Number.isInteger(command.throughRound) || command.throughRound < 1 || command.throughRound > state.lastNarratedRound) return { code: "staleSummary" };
  if (command.throughRound <= latestSummaryRound(state.summaries, command.visibility)) return { code: "staleSummary" };
  decision.emit({ kind: "summaryRecorded", throughRound: command.throughRound, visibility: command.visibility, text });
  return null;
}

export function compactSceneNotes(decision: Decision, command: Extract<CampaignCommand, { kind: "compactSceneNotes" }>): Rejection | null {
  if (decision.ctx.actor.kind !== "system") return { code: "systemOnly" };
  const text = command.text.trim();
  const previous = decision.state.sceneSummaries?.[command.sceneId];
  const notes = (decision.state.sceneNotes ?? []).filter((note) => note.sceneId === command.sceneId && note.roundNumber <= command.throughRound);
  if (text.length === 0 || text.length > maxSummaryLength) return { code: "invalidSummary", problem: "text" };
  if (vitalNumbers.test(text)) return { code: "invalidSummary", problem: "numbers" };
  if (!Number.isInteger(command.throughRound) || command.throughRound < 1 || command.throughRound > decision.state.lastNarratedRound || notes.length === 0 || command.throughRound <= (previous?.throughRound ?? 0)) {
    return { code: "staleSummary" };
  }
  decision.emit({ kind: "sceneNotesCompacted", sceneId: command.sceneId, throughRound: command.throughRound, text });
  return null;
}

// Adds a fact to an entity's ledger entry. The first recorded name is the
// canonical spelling; a later fact under a different name is refused so the
// DM cannot drift names.
export function recordLedgerFact(decision: Decision, command: RecordLedgerFactCommand): Rejection | null {
  if (decision.ctx.actor.kind !== "system") return { code: "systemOnly" };
  if (!isLedgerEntityId(command.entityId)) return { code: "invalidLedgerFact", problem: "entityId" };
  const fact = command.fact.trim();
  const canonicalName = command.canonicalName.trim();
  if (fact.length === 0 || fact.length > maxLedgerFactLength) return { code: "invalidLedgerFact", problem: "fact" };
  if (canonicalName.length === 0) return { code: "invalidLedgerFact", problem: "canonicalName" };
  const existing = decision.state.ledger[command.entityId];
  if (existing !== undefined && existing.canonicalName !== canonicalName) {
    return { code: "canonicalNameLocked", canonicalName: existing.canonicalName };
  }
  decision.emit({ kind: "ledgerFactRecorded", entityId: command.entityId, canonicalName, fact, visibility: command.visibility });
  return null;
}
