import type { CampaignLanguage, SceneId } from "../adventure/adventure-bible.js";
import type { CharacterSheet, CheckTest } from "../character/character-sheet.js";
import type { EncounterSpec, PlannedEffect } from "../commands/campaign-command.js";
import type { EncounterState } from "../combat/combat-state.js";
import type { HeroStatus } from "../combat/combatant-profile.js";
import type { CampaignId, CharacterId, CheckId, Instant, RollId, UserId } from "../core/ids.js";
import type { D20TestRoll, D20TestSpec } from "../dice/d20-test.js";
import type { RollMoments } from "../dice/roll-moments.js";
import type { LedgerEntry } from "../ledger/ledger.js";
import type { ContentId } from "../rules/content-id.js";
import type { DcTier } from "../rules/difficulty.js";

// The in-memory aggregate the engine decides against. The repository
// assembles it from the campaign tables; evolve() produces the next one.
export interface CampaignState {
  readonly campaignId: CampaignId;
  readonly organizerId: UserId;
  readonly status: CampaignStatus;
  readonly language: CampaignLanguage;
  readonly pacing: Pacing;
  readonly sceneId: SceneId | null;
  readonly members: Readonly<Record<UserId, MemberState>>;
  readonly characters: Readonly<Record<CharacterId, CharacterSheet>>;
  // The current round, or null between rounds (after a quiet round, or
  // before the first one).
  readonly round: RoundState | null;
  readonly lastRoundNumber: number;
  // The last round the Narrator described; guards against narrating twice.
  readonly lastNarratedRound: number;
  // Checks of the current round only; earlier ones live in the event log.
  readonly checks: Readonly<Record<CheckId, CheckState>>;
  readonly ledger: Readonly<Record<string, LedgerEntry>>;
  // The current or last fight; exploration rounds wait while it is active.
  readonly encounter: EncounterState | null;
  // A fight the Planner started; it begins after the round is narrated.
  readonly pendingEncounter: EncounterSpec | null;
  // Every encounter ID started in this campaign; each runs once.
  readonly encounterHistory: readonly string[];
  // Skill-challenge clocks by ID, created the first time they advance.
  readonly clocks: Readonly<Record<string, ClockState>>;
  // Clues the party has learned, in the order revealed.
  readonly clues: readonly RevealedClue[];
  // Heroes' HP and limited resources between fights; a hero missing here is
  // fresh (full HP, every slot and use).
  readonly heroStatus: Readonly<Record<CharacterId, HeroStatus>>;
  // Items the party holds in common: loot from fights and a fallen hero's gear.
  readonly stash: readonly ContentId<"item">[];
  // The party's gold, found as loot.
  readonly gold: number;
  // Trade offers waiting for the other hero's owner to answer.
  readonly offers: Readonly<Record<string, ItemOffer>>;
  // Numbers offer IDs deterministically.
  readonly offerCount: number;
  // The party as it stood when the current fight began; a retry restores it.
  readonly fightCheckpoint: FightCheckpoint | null;
}

export interface FightCheckpoint {
  readonly characters: Readonly<Record<CharacterId, CharacterSheet>>;
  readonly heroStatus: Readonly<Record<CharacterId, HeroStatus>>;
  readonly stash: readonly ContentId<"item">[];
  readonly gold: number;
  readonly offers: Readonly<Record<string, ItemOffer>>;
  readonly offerCount: number;
}

// One hero offers an item, optionally for one of the other hero's in return.
// The receiver's owner must accept; nothing moves before then.
export interface ItemOffer {
  readonly id: string;
  readonly fromCharacterId: CharacterId;
  readonly toCharacterId: CharacterId;
  readonly give: ContentId<"item">;
  readonly want: ContentId<"item"> | null;
}

// active: play proceeds. waitingForPlayers: nobody is present; no rounds,
// timers, auto-rolls, or model calls until someone returns and continues.
export type CampaignStatus = "active" | "waitingForPlayers";

export interface Pacing {
  // null: no timer; the window closes when everyone has responded or the
  // organizer closes it.
  readonly roundSeconds: number | null;
  readonly rollSeconds: number | null;
  readonly turnSeconds: number | null;
  // Consecutive timed-out rounds before a player is marked away.
  readonly awayAfterMisses: number;
}

export interface MemberState {
  readonly userId: UserId;
  readonly characterId: CharacterId | null;
  readonly availability: "present" | "away";
  readonly consecutiveMisses: number;
}

// collecting: players submit. planning: waiting for the Planner.
// resolving: checks pending or rolling.
export type RoundStatus = "collecting" | "planning" | "resolving";

export interface RoundState {
  readonly number: number;
  readonly status: RoundStatus;
  // Frozen when the round opens; returning players join the next round.
  readonly participants: readonly CharacterId[];
  readonly submissions: Readonly<Record<CharacterId, Submission>>;
  readonly closesAt: Instant | null;
  readonly resolutions: Readonly<Record<CharacterId, Resolution>>;
  // The applied plan's story effects, evaluated when the round resolves.
  readonly effects: readonly PlannedEffect[];
}

export type Submission =
  | { readonly kind: "action"; readonly text: string; readonly revision: number }
  | { readonly kind: "pass" }
  // Timed out, or the window closed before they responded.
  | { readonly kind: "missed" }
  // The player went away during the window; not counted as a miss.
  | { readonly kind: "excused" };

export type Resolution =
  | { readonly kind: "automatic"; readonly reason: string }
  | { readonly kind: "impossible"; readonly reason: string }
  | { readonly kind: "check"; readonly checkId: CheckId };

export interface CheckState {
  readonly id: CheckId;
  readonly roundNumber: number;
  readonly characterId: CharacterId;
  readonly test: CheckTest;
  readonly dcTier: DcTier;
  readonly dc: number;
  // Fixed before the roll, including advantage and every modifier.
  readonly spec: D20TestSpec;
  readonly deadline: Instant | null;
  readonly status: "pending" | "rolling" | "resolved";
  readonly rollId: RollId;
  readonly timedOut: boolean;
  readonly result: CheckResult | null;
}

export interface CheckResult {
  readonly roll: D20TestRoll;
  readonly success: boolean;
  readonly moments: RollMoments;
}

export interface ClockState {
  readonly segments: number;
  readonly filled: number;
}

export interface RevealedClue {
  readonly id: string;
  readonly text: string;
}

export function presentMembers(state: CampaignState): readonly MemberState[] {
  return Object.values(state.members).filter((member) => member.availability === "present");
}

// A hero who fell for good (three failed death saves) stays out of play; their
// player joins a new hero.
export function isFallen(state: CampaignState, characterId: CharacterId): boolean {
  return state.heroStatus[characterId]?.dead === true;
}

export function memberOwning(state: CampaignState, characterId: CharacterId): MemberState | undefined {
  const ownerId = state.characters[characterId]?.ownerUserId;
  return ownerId === undefined ? undefined : state.members[ownerId];
}
