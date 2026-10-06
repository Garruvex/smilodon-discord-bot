import { findScene, type AdventureBible } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { CampaignEvent } from "../../../domain/campaign/events/campaign-event.js";
import type { CampaignState, MoveReason } from "../../../domain/campaign/state/campaign-state.js";
import { roundRecords } from "../dm/round-records.js";

// What the table may read back about the story so far (plan §3, Journal and
// recap). Public only: nothing from a private summary, a secret ledger fact,
// the DM's notes or an NPC's secret can be here, because none of it is read.

export interface JournalView {
  // Where the party is now.
  readonly sceneTitle: string | null;
  // The Chronicler's public summaries, oldest first, each with the rounds it covers.
  readonly chapters: readonly { readonly fromRound: number; readonly throughRound: number; readonly text: string }[];
  // Public things the world remembers, by canonical name.
  readonly people: readonly { readonly name: string; readonly facts: readonly string[] }[];
  readonly clues: readonly string[];
}

export function buildJournal(state: CampaignState, bible: AdventureBible): JournalView {
  let previous = 0;
  const chapters = (state.summaries ?? [])
    .filter((summary) => summary.visibility === "public")
    .map((summary) => {
      const chapter = { fromRound: previous + 1, throughRound: summary.throughRound, text: summary.text };
      previous = summary.throughRound;
      return chapter;
    });
  const people = Object.values(state.ledger).flatMap((entry) => {
    const facts = entry.facts.filter((fact) => fact.visibility === "public").map((fact) => fact.text);
    return facts.length === 0 ? [] : [{ name: entry.canonicalName, facts }];
  });
  return { sceneTitle: findScene(bible, state.sceneId)?.title ?? null, chapters, people, clues: state.clues.map((clue) => clue.text) };
}

// A short catch-up for someone coming back to the table: the latest chapter,
// what was told in the last rounds, and what the party knows.
export interface RecapView {
  readonly sceneTitle: string | null;
  readonly latestChapter: string | null;
  // The Narrator's last few tellings, oldest first; only text already shown to everyone.
  readonly recent: readonly string[];
  readonly clues: readonly string[];
}

export function buildRecap(state: CampaignState, events: readonly CampaignEvent[], bible: AdventureBible, recentRounds = 2): RecapView {
  const chapter = [...(state.summaries ?? [])].reverse().find((summary) => summary.visibility === "public");
  const recent = roundRecords(events)
    .filter((record) => record.narration !== null)
    .slice(-recentRounds)
    .map((record) => record.narration ?? "");
  return { sceneTitle: findScene(bible, state.sceneId)?.title ?? null, latestChapter: chapter?.text ?? null, recent, clues: state.clues.map((clue) => clue.text) };
}

// Where the party has been, one entry per stay, oldest first (plan: scene
// flow). A scene visited twice appears twice. Public only, like the journal:
// the Narrator's tellings the whole table already read, the clues they found,
// and how many fights broke out. Empty until the party first moves.
export interface PlaceView {
  readonly sceneTitle: string;
  readonly fromRound: number;
  // The last round played there; null while the party is still there.
  readonly throughRound: number | null;
  readonly arrivedBy: MoveReason | null;
  // The opening of the Narrator's last telling there, cut short.
  readonly told: string | null;
  readonly cluesFound: number;
  readonly fights: number;
  // Clues authored for the scene that the party has not found. Only for a place already left: here, the party may still find them.
  readonly cluesLeft: number;
}

const toldLength = 140;

export function buildPlaces(state: CampaignState, events: readonly CampaignEvent[], bible: AdventureBible): readonly PlaceView[] {
  const records = roundRecords(events);
  const found = new Set(state.clues.map((clue) => clue.id));
  return (state.visits ?? []).map((visit) => {
    const inVisit = (round: number): boolean => round >= visit.arrivedRound && (visit.leftRound === undefined || round < visit.leftRound);
    const last = [...records].reverse().find((record) => inVisit(record.number) && record.narration !== null);
    return {
      sceneTitle: findScene(bible, visit.sceneId)?.title ?? visit.sceneId,
      fromRound: visit.arrivedRound,
      throughRound: visit.leftRound === undefined ? null : Math.max(visit.arrivedRound, visit.leftRound - 1),
      arrivedBy: visit.arrivedBy ?? null,
      told: last?.narration == null ? null : opening(last.narration),
      cluesFound: events.filter((event) => event.kind === "clueRevealed" && inVisit(event.roundNumber)).length,
      fights: events.filter((event) => event.kind === "encounterQueued" && inVisit(event.roundNumber)).length,
      cluesLeft: visit.leftRound === undefined ? 0 : bible.clues.filter((clue) => clue.sceneId === visit.sceneId && !found.has(clue.id)).length,
    };
  });
}

function opening(narration: string): string {
  const flat = narration.replace(/\s+/g, " ").trim();
  const sentence = /^.*?[.!?。！？](?=\s|$)/.exec(flat)?.[0] ?? flat;
  return sentence.length <= toldLength ? sentence : `${sentence.slice(0, toldLength - 1)}…`;
}
