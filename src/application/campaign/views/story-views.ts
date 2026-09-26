import { findScene, type AdventureBible } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { CampaignEvent } from "../../../domain/campaign/events/campaign-event.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";
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
