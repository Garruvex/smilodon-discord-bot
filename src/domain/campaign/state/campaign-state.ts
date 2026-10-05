import type { CompanionRoster } from "../companions/companion-roster.js";
import type { CampaignLanguage, NpcId, SceneId } from "../adventure/adventure-bible.js";
import type { CharacterSheet, CheckTest } from "../character/character-sheet.js";
import type { EncounterSpec, PartyEffect, PlannedEffect } from "../commands/campaign-command.js";
import type { EncounterState } from "../combat/combat-state.js";
import type { HeroStatus } from "../combat/combatant-profile.js";
import type { CampaignId, CharacterId, CheckId, Instant, RollId, UserId } from "../core/ids.js";
import type { D20TestRoll, D20TestSpec } from "../dice/d20-test.js";
import type { DiceExpression } from "../dice/dice-expression.js";
import type { RollMoments } from "../dice/roll-moments.js";
import type { LedgerEntry } from "../ledger/ledger.js";
import type { ContentId } from "../rules/content-id.js";
import type { DcTier } from "../rules/difficulty.js";
import type { Ability, DamageType } from "../rules/effects.js";

// The in-memory aggregate the engine decides against. The repository
// assembles it from the campaign tables; evolve() produces the next one.
// A story object with no rules of its own: a name and what the party knows of it.
import type { WorldState } from "./world-state.js";

export interface Keepsake {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

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
  // The adventure's opening, told before the first round: pending while the
  // Narrator writes it, waiting while the table gets ready, done once the
  // first round can open. Absent in games that started before openings
  // existed, which have none to wait for.
  readonly opening?: "pending" | "waiting" | "done";
  // Who has pressed Ready while the table is waiting.
  readonly openingReady?: readonly UserId[];
  // The last round the Narrator described; guards against narrating twice.
  readonly lastNarratedRound: number;
  // What the Chronicler condensed, oldest first (plan §6, Context layers D).
  // Each covers the rounds after the previous one of its kind, through its own
  // round. Absent in games that started before summaries existed.
  readonly summaries?: readonly StorySummary[];
  // Public, narrator-written changes for each scene. Recent notes stay verbatim;
  // the Chronicler folds a scene's notes into sceneSummaries when they grow large.
  readonly sceneNotes?: readonly SceneNote[];
  readonly sceneSummaries?: Readonly<Record<string, SceneSummary>>;
  // Pending notes are not shown as facts. The asynchronous judge either admits
  // a verified wording to sceneNotes or drops it after its bounded retries.
  readonly pendingSceneNotes?: readonly PendingSceneNote[];
  // Who may play a hero in a fight while its owner is away: owner -> proxy.
  // A grant does nothing while the owner is present, and only reaches turns
  // (never the owner's items, story choices or anything outside a fight).
  readonly proxies?: Readonly<Record<UserId, UserId>>;
  // Heroes whose seat was freed, by name, so what was already told about them still reads.
  readonly retiredHeroes?: Readonly<Record<CharacterId, string>>;
  // Someone used the safety pause: the next narration is asked to keep gentle
  // (plan §5, Table safety). Cleared once that narration is told.
  readonly safetyNote?: boolean;
  // The round in which the party last changed scene: the moment a chapter closes.
  readonly sceneChangedRound?: number;
  // A move to another scene the table has not yet agreed to. It settles when
  // the next round closes: the party goes unless more than half of the
  // present players pressed Stay (a tie stays).
  readonly pendingMove?: PendingMove;
  readonly sceneMoveSettledRound?: number;
  readonly sceneMoveSettledDestination?: SceneId | null;
  // A scene the table voted to stay out of; the Planner does not propose it again until the party moves on.
  readonly sceneMoveDeclinedScene?: SceneId;
  // Each stay in a scene, oldest first; the last is where the party is. Absent in
  // games that began before visits were kept: the first move starts the record.
  readonly visits?: readonly SceneVisit[];
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
  // Story facts an adventure sets and later text requires (flag name to value); absent: none yet.
  readonly flags?: Readonly<Record<string, number>>;
  // Story objects the party carries, by id; absent: none yet.
  readonly keepsakes?: Readonly<Record<string, Keepsake>>;
  // The story's day, time of day and weather; absent when the adventure gives none.
  readonly world?: WorldState;
  // Heroes' HP and limited resources between fights; a hero missing here is
  // fresh (full HP, every slot and use).
  readonly heroStatus: Readonly<Record<CharacterId, HeroStatus>>;
  // Items the party holds in common: loot from fights and a fallen hero's gear.
  readonly stash: readonly ContentId<"item">[];
  // The party's purse: gold found as loot when the table pools it.
  readonly gold: number;
  // Each hero's own coins (gold shared out under the "split" house rule).
  // A hero missing here has none.
  readonly heroGold?: Readonly<Record<CharacterId, number>>;
  // Trade offers waiting for the other hero's owner to answer.
  readonly offers: Readonly<Record<string, ItemOffer>>;
  // Numbers offer IDs deterministically.
  readonly offerCount: number;
  // The party as it stood when the current fight began; a retry restores it.
  readonly fightCheckpoint: FightCheckpoint | null;
  // Why play is stopped, when it is stopped on purpose: the organizer paused,
  // or the bot restarted and waits for the organizer to resume. Null while
  // playing, and while merely waiting for players to come back.
  readonly pausedBy: PauseReason | null;
  // A hero's haggle roll, waiting for its result (engine/shop.ts). One at a
  // time per hero; cleared the moment the roll settles the trade.
  readonly hagglePending?: Readonly<Record<CharacterId, PendingHaggle>>;
  // A trade already decided (bought, sold, or a settled haggle), waiting for
  // the Narrator to voice the NPC's reaction; removed once recordTradeNarration
  // lands. Not gameplay state — narration is the only thing still pending.
  readonly trades: Readonly<Record<string, TradeRecord>>;
  readonly tradeCount: number;
  // A hero's roll to pry an NPC's secret loose, waiting for its result
  // (engine/dialogue.ts). One at a time per hero; cleared once the roll
  // settles the conversation.
  readonly pressPending?: Readonly<Record<CharacterId, PendingPress>>;
  // Each NPC can be pressed for their secret once by the party; the four
  // skill buttons are alternative approaches to that single attempt.
  readonly npcPressAttempts?: readonly NpcId[];
  // A conversation already decided (a plain question, or a settled press),
  // waiting for the Narrator to voice the NPC's reply; removed once
  // recordDialogueNarration lands. Not gameplay state, same as trades.
  readonly dialogues: Readonly<Record<string, DialogueRecord>>;
  readonly dialogueCount: number;
  // NPCs who have given up their authored secret (adventure-bible.ts's
  // BibleNpc.secret) to a successful press; once true, pressNpc refuses a
  // second attempt on that NPC and later conversation may reference it.
  // NPCs killed in a fight: they are no longer in their scene, and can be neither spoken to nor traded with.
  readonly npcsDown?: readonly NpcId[];
  readonly npcSecretsRevealed?: Readonly<Record<NpcId, boolean>>;
  // A ritual spell cast outside combat, waiting for the Narrator to describe
  // what it reveals or does (engine/utility-magic.ts); removed once
  // recordUtilityCastNarration lands. Not gameplay state, same as trades.
  readonly utilityCasts: Readonly<Record<string, UtilityCastRecord>>;
  readonly utilityCastCount: number;
  // A hero's saving throw against a travel or environmental hazard, waiting
  // for its result (engine/travel.ts). One at a time per hero.
  readonly hazardPending?: Readonly<Record<CharacterId, PendingHazard>>;
  // A settled hazard, waiting for the Narrator to describe the toll of the
  // journey; removed once recordHazardNarration lands. Not gameplay state —
  // the Exhaustion it grants, if any, already landed on hazardSettled.
  readonly hazards: Readonly<Record<string, HazardRecord>>;
  readonly hazardCount: number;
  // Damage between fights (a fall, drowning, a trap) waiting for its dice (engine/environmental-damage.ts). One at a time per hero.
  readonly damagePending?: Readonly<Record<CharacterId, PendingEnvironmentalDamage>>;
  readonly damageCount?: number;
  // A slotted healing spell cast outside combat, waiting for its dice
  // (engine/healing-magic.ts). One at a time per caster. Settled healings are
  // told from the saved event; nothing about them is kept here but the count.
  readonly healingPending?: Readonly<Record<CharacterId, PendingHealing>>;
  // After a short rest, until the next round or fight begins: the heroes may spend Hit Dice, each one rolled.
  readonly shortRestOpen?: boolean;
  // A rest the organizer asked for while a round or a fight is going: taken when it ends, before the next round opens (engine/rest.ts).
  // The scene's long-rest lines are kept with it, and used only if the party is still in that scene.
  readonly pendingRest?: { readonly rest: "short" | "long"; readonly sceneId: string | null; readonly story: readonly PartyEffect[] };
  // The party is resting: the next round waits until the organizer finishes (continue). Hit Dice are spent in this time.
  readonly resting?: "short" | "long";
  readonly hitDicePending?: Readonly<Record<CharacterId, PendingHitDice>>;
  readonly hitDiceCount?: number;
  readonly healingCount: number;
  // Creatures the heroes brought along between fights (companions/companion-roster.ts). Absent until the first one.
  readonly companions?: CompanionRoster | undefined;
}

// Damage between fights, its dice requested: fixed the moment the roll is asked for.
export interface PendingEnvironmentalDamage {
  readonly characterId: CharacterId;
  readonly cause: EnvironmentalCause;
  readonly expression: DiceExpression;
  readonly damageType: DamageType;
  readonly rollId: RollId;
}

export type EnvironmentalCause = "fall" | "suffocation" | "other";

// Damage between fights, settled: what was rolled, what the hero took (after resistance) and where that leaves them.
export interface EnvironmentalDamageRecord {
  readonly id: string;
  readonly characterId: CharacterId;
  readonly cause: EnvironmentalCause;
  readonly expression: DiceExpression | null;
  readonly rolled: number;
  readonly taken: number;
  readonly hpAfter: number;
  readonly dead: boolean;
}

// Hit Dice a hero chose to spend on a short rest, their dice requested: the dice and the Constitution bonus are fixed before the roll.
export interface PendingHitDice {
  readonly characterId: CharacterId;
  readonly count: number;
  readonly expression: DiceExpression;
  readonly rollId: RollId;
}

// A healing spell cast outside combat, its dice requested: the expression is
// fixed the moment the roll is requested (the spell's own plan plus any bonus).
export interface PendingHealing {
  readonly casterId: CharacterId;
  readonly targetId: CharacterId;
  readonly spellId: ContentId<"spell">;
  readonly slotLevel: number;
  readonly expression: DiceExpression;
  readonly rollId: RollId;
}

// A settled healing spell: what was rolled and how much hit points it restored
// (less than rolled when the target was nearly whole).
export interface HealingRecord {
  readonly id: string;
  readonly casterId: CharacterId;
  readonly targetId: CharacterId;
  readonly spellId: ContentId<"spell">;
  readonly slotLevel: number;
  readonly expression: DiceExpression;
  readonly rolled: number;
  readonly healed: number;
  readonly hpAfter: number;
}

// A pending Persuasion/Deception/Intimidation check over a specific item's
// price (engine/shop.ts's hagglePrice): dc and spec are fixed the moment the
// roll is requested, the same way a round-plan CheckState freezes them.
export interface PendingHaggle {
  readonly characterId: CharacterId;
  readonly npcId: NpcId;
  readonly itemId: ContentId<"item">;
  readonly direction: "buy" | "sell";
  readonly listedPrice: number;
  readonly test: CheckTest;
  readonly dc: number;
  readonly spec: D20TestSpec;
  readonly rollId: RollId;
}

// A completed trade: an instant buy/sell at the listed price (haggle null),
// or one settled by a haggle roll (character/leveling.ts's dice, never the
// model's own judgment — see docs/dnd-engine-architecture.md's step on this).
// "cannotAfford": the haggle succeeded but even the negotiated price was more
// gold than the hero had; nothing moved, but the attempt still gets narrated.
export interface TradeRecord {
  readonly id: string;
  readonly characterId: CharacterId;
  readonly npcId: NpcId;
  readonly itemId: ContentId<"item">;
  readonly direction: "buy" | "sell";
  readonly listedPrice: number;
  readonly finalPrice: number;
  readonly outcome: "completed" | "cannotAfford";
  readonly haggle: { readonly test: CheckTest; readonly dc: number; readonly total: number; readonly success: boolean; readonly moments: RollMoments } | null;
}

// A pending Insight/Persuasion/Deception/Intimidation check to pry an NPC's
// secret loose (engine/dialogue.ts's pressNpc): frozen the same way a
// haggle's PendingHaggle is, the moment the roll is requested.
export interface PendingPress {
  readonly characterId: CharacterId;
  readonly npcId: NpcId;
  readonly test: CheckTest;
  readonly dc: number;
  readonly spec: D20TestSpec;
  readonly rollId: RollId;
}

// A settled conversation with an NPC: a plain question (kind "ask", check
// null, always answered) or a press at their secret (kind "press", question
// null) — dice decide whether it gives anything up, never the model asked to
// play the NPC (same rule engine/shop.ts's haggling already follows).
export interface DialogueRecord {
  readonly id: string;
  readonly characterId: CharacterId;
  readonly npcId: NpcId;
  readonly kind: "ask" | "press";
  readonly question: string | null;
  readonly check: { readonly test: CheckTest; readonly dc: number; readonly total: number; readonly natural?: number; readonly success: boolean; readonly moments: RollMoments } | null;
}

// A ritual spell cast outside combat (engine/utility-magic.ts): no roll, no
// mechanical Effect — the spell's own definition already validated as known
// and ritual-tagged, so this only waits on the Narrator to describe what it
// reveals or does, grounded in the scene like any other narration.
export interface UtilityCastRecord {
  readonly id: string;
  readonly characterId: CharacterId;
  readonly spellId: ContentId<"spell">;
}

// A pending saving throw against a travel or environmental hazard
// (engine/travel.ts's faceHazard): the ability and DC are named by whoever
// calls it (the organizer, narrating the terrain) — the engine has no bible
// access to look up a scene's own hazard, the same trust boundary an
// EncounterSpec's zones and monsters already have.
export interface PendingHazard {
  readonly characterId: CharacterId;
  readonly ability: Ability;
  readonly dc: number;
  readonly spec: D20TestSpec;
  readonly rollId: RollId;
}

// A settled hazard: a real saving throw decided whether it costs anything —
// SRD's own "gains a level of exhaustion on a failed save" shape for forced
// marches and harsh terrain — never narrative fiat.
export interface HazardRecord {
  readonly id: string;
  readonly characterId: CharacterId;
  readonly ability: Ability;
  readonly dc: number;
  readonly total: number;
  readonly success: boolean;
  readonly moments: RollMoments;
  readonly exhaustionGained: number;
}

export type PauseReason = "organizer" | "recovery" | "safety";

export interface FightCheckpoint {
  readonly characters: Readonly<Record<CharacterId, CharacterSheet>>;
  readonly heroStatus: Readonly<Record<CharacterId, HeroStatus>>;
  readonly stash: readonly ContentId<"item">[];
  readonly gold: number;
  readonly offers: Readonly<Record<string, ItemOffer>>;
  readonly offerCount: number;
  readonly companions?: CompanionRoster | undefined;
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

// One stay in a scene. The party can come back, so the same scene may have
// several, each with its own id. A round belongs to the visit it was played in:
// from the round the party arrived (the round the move happened, whose telling
// is already in the new scene) up to, not including, the round it left.
export interface SceneVisit {
  readonly id: string;
  readonly sceneId: SceneId;
  readonly arrivedRound: number;
  // The move round's narration describes the departure and belongs to where it began.
  readonly narratedThroughRound?: number;
  // Absent while the party is still there.
  readonly leftRound?: number;
  readonly cameFrom?: SceneId;
  // How the party got here: the table agreed, the organizer sent it, or the story did.
  readonly arrivedBy?: MoveReason;
}

export type MoveReason = "agreed" | "organizer" | "story";

export interface PendingMove {
  readonly sceneId: SceneId;
  readonly proposedRound: number;
  // What happens on arrival, the scene change first.
  readonly effects: readonly PartyEffect[];
  readonly objectors: readonly UserId[];
  // Players who explicitly voted to go; missing votes still follow the table's go-by-silence rule.
  readonly supporters?: readonly UserId[];
  readonly proposedBy?: UserId;
  // Who wants to go: the heroes behind the proposal, when it names them.
  readonly heroes?: readonly CharacterId[];
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

// public: written from what the table saw, so anyone may read it. private:
// written for the DM from everything it knows, so only the Planner gets it.
export interface StorySummary {
  readonly throughRound: number;
  readonly visibility: "public" | "private";
  readonly text: string;
}

export interface SceneNote {
  readonly roundNumber: number;
  readonly sceneId: string;
  readonly text: string;
}

export interface PendingSceneNote extends SceneNote {
  readonly noteIndex: number;
}

export interface SceneSummary {
  readonly throughRound: number;
  readonly text: string;
}

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
