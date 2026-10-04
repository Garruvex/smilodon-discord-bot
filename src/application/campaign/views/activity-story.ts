import { findScene, type AdventureBible } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { CampaignEvent } from "../../../domain/campaign/events/campaign-event.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";
import { encounterRecords, type CombatTargetResult } from "../dm/combat-records.js";

// The story as the Activity shows it: what the table has already read in the Adventure channel, rebuilt from the event log, newest last. Public
// only (the Narrator's tellings, what heroes did and said, the visible results of a fight): nothing from a private summary, the DM's notes or a
// hidden roll can be here, because only these public event kinds are read.
export type StoryEntry =
  | { readonly id: string; readonly kind: "narration"; readonly text: string }
  | { readonly id: string; readonly kind: "action"; readonly who: string; readonly text: string }
  | { readonly id: string; readonly kind: "speech"; readonly who: string; readonly text: string }
  | { readonly id: string; readonly kind: "clue"; readonly text: string }
  // A place change, the start of a fight or its end: the client words it.
  | { readonly id: string; readonly kind: "system"; readonly code: "scene" | "combatBegins" | "victory" | "defeat"; readonly text: string | null }
  | { readonly id: string; readonly kind: "combat"; readonly who: string; readonly using: string; readonly opportunity: boolean; readonly targets: readonly StoryTarget[] }
  // A hero going down, or a foe falling: the moments the Activity may call out.
  | { readonly id: string; readonly kind: "alert"; readonly tone: "down" | "slain"; readonly name: string };

export interface StoryTarget {
  readonly name: string;
  readonly check: CombatTargetResult["check"];
  readonly damage: number;
  readonly heal: number;
  readonly prone: boolean;
}

// How many of the latest entries a snapshot carries.
export const storyLength = 60;

interface Placed {
  readonly order: number;
  entry: StoryEntry;
}

export function buildActivityStory(state: CampaignState, events: readonly CampaignEvent[], bible: AdventureBible, glossary: Glossary): readonly StoryEntry[] {
  const placed: Placed[] = [];
  const add = (order: number, entry: StoryEntry): void => { placed.push({ order, entry }); };
  const heroName = (id: string): string => state.characters[id]?.name ?? id;
  // A hero's wording for a round may be replaced; the entry keeps its place and takes the newest words.
  const actionAt = new Map<string, Placed>();

  const narrate = (index: number, text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length > 0) add(index, { id: `e${index}`, kind: "narration", text: trimmed });
  };

  // Where each declared fight action sits in the log, so its result line can be put in order with the rest.
  const declaredAt = new Map<string, number>();
  events.forEach((event, index) => { if (event.kind === "resolutionDeclared") declaredAt.set(event.resolution.id, index); });

  events.forEach((event, index) => {
    switch (event.kind) {
      case "openingRecorded":
      case "narrationRecorded":
      case "combatNarrationRecorded":
      case "tradeNarrated":
      case "dialogueNarrated":
      case "utilityCastNarrated":
      case "hazardNarrated":
        narrate(index, event.text);
        break;
      case "actionSubmitted": {
        const key = `${event.roundNumber}:${event.characterId}`;
        const text = event.text.trim();
        const found = actionAt.get(key);
        if (found !== undefined && found.entry.kind === "action") found.entry = { ...found.entry, text };
        else if (text.length > 0) {
          const item: Placed = { order: index, entry: { id: `e${index}`, kind: "action", who: heroName(event.characterId), text } };
          actionAt.set(key, item);
          placed.push(item);
        }
        break;
      }
      case "heroSpoke":
        if (event.text.trim().length > 0) add(index, { id: `e${index}`, kind: "speech", who: heroName(event.characterId), text: event.text.trim() });
        break;
      case "clueRevealed":
        add(index, { id: `e${index}`, kind: "clue", text: event.text });
        break;
      case "sceneTransitioned":
        add(index, { id: `e${index}`, kind: "system", code: "scene", text: findScene(bible, event.sceneId)?.title ?? null });
        break;
      case "encounterStarted":
        add(index, { id: `e${index}`, kind: "system", code: "combatBegins", text: null });
        break;
      case "encounterEnded":
        add(index, { id: `e${index}`, kind: "system", code: event.outcome, text: null });
        break;
      default:
        break;
    }
  });

  // What a fight action did, with who it hit and who went down.
  const heroNames = new Set(Object.values(state.characters).map((sheet) => sheet.name));
  for (const encounter of encounterRecords(events, { state, bible, glossary })) {
    for (const round of encounter.rounds) {
      for (const beat of round.beats) {
        if (beat.kind !== "action" || beat.resolutionId === undefined) continue;
        const at = declaredAt.get(beat.resolutionId);
        if (at === undefined) continue;
        const id = `c${at}`;
        add(at + 0.5, {
          id,
          kind: "combat",
          who: beat.actor,
          using: beat.using,
          opportunity: beat.opportunity,
          targets: beat.targets.map((target) => ({ name: target.name, check: target.check, damage: Math.max(0, -target.hpChange), heal: Math.max(0, target.hpChange), prone: target.knockedProne })),
        });
        beat.targets.forEach((target, n) => {
          if (target.condition === "dead" || target.condition === "unconscious") {
            const hero = heroNames.has(target.name);
            add(at + 0.6 + n / 1000, { id: `${id}a${n}`, kind: "alert", tone: hero ? "down" : target.condition === "dead" ? "slain" : "down", name: target.name });
          }
        });
      }
    }
  }

  return placed.sort((left, right) => left.order - right.order).slice(-storyLength).map((item) => item.entry);
}
