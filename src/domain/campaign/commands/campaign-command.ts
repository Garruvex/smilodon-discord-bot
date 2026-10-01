import type { NpcId, SceneId } from "../adventure/adventure-bible.js";
import type { CharacterSheet, CheckTest, Skill } from "../character/character-sheet.js";
import type { CharacterId, CheckId, RollId, UserId } from "../core/ids.js";
import type { RollResult } from "../dice/roll-spec.js";
import type { ReminderTarget } from "../engine/engine-request.js";
import type { LedgerVisibility } from "../ledger/ledger.js";
import type { ContentId } from "../rules/content-id.js";
import type { DcTier, RollModeReason } from "../rules/difficulty.js";
import type { Ability, DamageType } from "../rules/effects.js";
import type { Keepsake } from "../state/campaign-state.js";
import type { TimeOfDay, Weather } from "../rules/world-rules.js";

// Who issued a command. Users are checked against saved campaign state
// (membership, ownership, organizer); the system covers timers and workers.
export type Actor = { readonly kind: "user"; readonly userId: UserId } | { readonly kind: "system" };

// Closed union: decide() handles every kind with an exhaustive switch.
export type CampaignCommand =
  // Opens the next round: by the system after narration (or after a quiet
  // round with someone present), or by a present member.
  | { readonly kind: "openRound" }
  // The game has started: the Narrator tells the opening, and the first round
  // opens once it is on the table.
  | { readonly kind: "beginAdventure" }
  | { readonly kind: "recordOpening"; readonly text: string }
  // A player is ready for the first round; it opens when every present player is.
  | { readonly kind: "ready" }
  // The organizer opens the first round without waiting for everyone.
  | { readonly kind: "beginPlay" }
  | { readonly kind: "submitAction"; readonly characterId: CharacterId; readonly text: string; readonly roundNumber?: number }
  | { readonly kind: "pass"; readonly characterId: CharacterId }
  | { readonly kind: "closeRound" }
  | { readonly kind: "roundTimerExpired"; readonly roundNumber: number }
  // The halfway timer of a long wait fired (system only; changes no state).
  | { readonly kind: "timerReminder"; readonly target: ReminderTarget }
  | { readonly kind: "applyRoundPlan"; readonly proposal: RoundPlanProposal }
  | { readonly kind: "requestRoll"; readonly checkId: CheckId }
  | { readonly kind: "rollTimerExpired"; readonly checkId: CheckId }
  | { readonly kind: "recordRoll"; readonly rollId: RollId; readonly result: RollResult }
  | { readonly kind: "markAway"; readonly userId: UserId }
  | { readonly kind: "markReturned"; readonly userId: UserId }
  // The owner lets another player at the table play their hero in fights while they are away, or takes it back.
  | { readonly kind: "grantProxy"; readonly proxyUserId: UserId }
  | { readonly kind: "revokeProxy" }
  // A player suggests heading to a scene: the same vote as a move the Planner proposes. The application checks the way is open and
  // supplies what arriving brings (the scene change first).
  | { readonly kind: "proposeMove"; readonly sceneId: SceneId; readonly effects: readonly PartyEffect[] }
  // The party is heading to a new scene. A player presses Stay to object, or takes it back.
  | { readonly kind: "objectToMove" }
  | { readonly kind: "withdrawObjection" }
  // The organizer settles a pending move now: the party goes, or stays where it is.
  | { readonly kind: "settleMove"; readonly outcome: "go" | "stay" }
  // Resumes a campaign that was waiting for players.
  | { readonly kind: "continue" }
  // Stops play: every timer is cancelled and no round, roll, or model work
  // runs until the organizer resumes (with continue). "recovery" is the
  // system pausing timed campaigns after a restart.
  // "safety": any player stops play for everyone, without saying who asked;
  // only the organizer lifts it.
  | { readonly kind: "pauseCampaign"; readonly reason: "organizer" | "recovery" | "safety" }
  // A hero's in-character words: no action, no cost, told to the table and the DM.
  | { readonly kind: "speak"; readonly characterId: CharacterId; readonly text: string }
  // The Planner could not produce a valid proposal after its retry.
  | { readonly kind: "reportPlannerFailure"; readonly roundNumber: number; readonly problems: readonly string[] }
  // The organizer asks the Planner to try the held round again.
  | { readonly kind: "retryPlan" }
  | { readonly kind: "recordNarration"; readonly roundNumber: number; readonly text: string }
  // The Narrator's flourish for a combat round, or the fight's closing line.
  | { readonly kind: "recordCombatNarration"; readonly encounterId: string; readonly round: number; readonly text: string }
  | RecordLedgerFactCommand
  // The organizer asks for the last narration to be told again; only the words change.
  | { readonly kind: "regenerateNarration"; readonly roundNumber: number }
  // The organizer asks for a picture of the last narrated round.
  | { readonly kind: "illustrateMoment"; readonly roundNumber: number }
  // The organizer asks for the last picture to be painted again.
  | { readonly kind: "redoPicture"; readonly subject: string }
  | { readonly kind: "replaceNarration"; readonly roundNumber: number; readonly text: string }
  // The Chronicler's condensed account of the rounds through `throughRound`.
  | { readonly kind: "recordSummary"; readonly throughRound: number; readonly visibility: "public" | "private"; readonly text: string }
  // Organizer, outside combat. Short: limited features recharge. Long: HP,
  // spell slots, and every feature recharge.
  // story: what the scene attaches to a long rest (lines, clues, flags, rewards, keepsakes), from the adventure.
  // The organizer corrects the story's day, time or weather (audited: the event says it was a correction, and why).
  | { readonly kind: "setWorld"; readonly day?: number; readonly time?: TimeOfDay; readonly weather?: Weather | null; readonly note?: string }
  | { readonly kind: "takeRest"; readonly rest: "short" | "long"; readonly story?: readonly PartyEffect[] }
  | InventoryCommand
  // Organizer, after a lost fight: play it again from its start, with fresh dice.
  | { readonly kind: "retryEncounter" }
  // A player's new hero: their first, or one to replace a fallen hero.
  | { readonly kind: "joinHero"; readonly sheet: CharacterSheet; readonly entrance?: string }
  // Declares which class the hero's next level lands in (character-build.ts's
  // BuildClass) — the same class they are already leveling, or a new one
  // (multiclassing in, gated by that class's SRD ability-score prerequisite).
  // skillChoice only matters, and is only validated, the moment that new
  // class's own multiclass skill is actually granted.
  | { readonly kind: "chooseClassLevel"; readonly characterId: CharacterId; readonly buildClass: string; readonly skillChoice?: string }
  // Spends one unspent Ability Score Improvement (character/leveling.ts's
  // asiLevels): +2 to one ability, or +1 to two, each capped at 20 by the engine.
  | { readonly kind: "chooseAsi"; readonly characterId: CharacterId; readonly allocation: { readonly plusTwo: Ability } | { readonly plusOne: readonly [Ability, Ability] } }
  // Swaps the hero's Fighting Style for another (character/fighting-styles.ts).
  | { readonly kind: "chooseFightingStyle"; readonly characterId: CharacterId; readonly styleId: string }
  // A warlock's Eldritch Invocations and Pact Boon (engine/warlock-choices.ts); a list or boon left out stays as it is.
  | { readonly kind: "chooseWarlockOptions"; readonly characterId: CharacterId; readonly invocations?: readonly string[]; readonly pactBoon?: string }
  // The organizer raises every living hero to this level (milestone
  // leveling, or a reward at an experience table). Not during a fight.
  | { readonly kind: "raiseLevel"; readonly level: number }
  | ShopCommand
  | DialogueCommand
  | UtilityMagicCommand
  | HealingMagicCommand
  | CompanionMagicCommand
  | RevivalMagicCommand
  | TravelCommand
  | CombatCommand;

// A hero trades with an NPC's shop outside combat (engine/shop.ts). The
// engine itself never reads the adventure bible (only the application layer
// does, the same as an EncounterSpec's zones and monsters): the price named
// here is trusted the same way, resolved from the NPC's authored stock by
// whoever issues the command. buyItem and sellItem are instant, at that
// price; hagglePrice tries for a better one first, over a real
// Persuasion/Deception/Intimidation check — never a model's own judgment
// call (docs/dnd-engine-architecture.md, the step this shipped in). Every
// trade, haggled or not, gets a Narrator line once settled
// (recordTradeNarration).
export type ShopCommand =
  | { readonly kind: "buyItem"; readonly characterId: CharacterId; readonly npcId: NpcId; readonly itemId: ContentId<"item">; readonly price: number }
  | { readonly kind: "sellItem"; readonly characterId: CharacterId; readonly npcId: NpcId; readonly itemId: ContentId<"item">; readonly price: number }
  | {
      readonly kind: "hagglePrice";
      readonly characterId: CharacterId;
      readonly npcId: NpcId;
      readonly itemId: ContentId<"item">;
      readonly direction: "buy" | "sell";
      readonly listedPrice: number;
      readonly skill: Skill;
    }
  | { readonly kind: "recordTradeNarration"; readonly tradeId: string; readonly text: string };

// Talking to an NPC outside combat (engine/dialogue.ts). askNpc is a free
// question, always answered from what the NPC is authored to say in public
// (BibleNpc.publicDescription); pressNpc tries to pry their authored secret
// loose over a real Insight, Persuasion, Deception, or Intimidation check —
// same "dice decide, never the model's own call" rule as hagglePrice.
export type DialogueCommand =
  | { readonly kind: "askNpc"; readonly characterId: CharacterId; readonly npcId: NpcId; readonly question: string }
  | { readonly kind: "pressNpc"; readonly characterId: CharacterId; readonly npcId: NpcId; readonly skill: Skill }
  | { readonly kind: "recordDialogueNarration"; readonly dialogueId: string; readonly text: string };

// Casting a spell outside combat (engine/utility-magic.ts). Scoped to ritual
// casting only (SpellDefinition.ritual) or a cantrip (level 0): both are
// free, so this never spends a slot — a hero who wants a slotted utility
// spell faster than a ritual's ten minutes has no command for that yet.
export type UtilityMagicCommand =
  | { readonly kind: "castRitualSpell"; readonly characterId: CharacterId; readonly spellId: ContentId<"spell"> }
  | { readonly kind: "recordUtilityCastNarration"; readonly castId: string; readonly text: string };

// A minute-long conjuring or a familiar, cast between fights (engine/companion-magic.ts): the creatures
// wait in the campaign and join the next fight. A ritual (Find Familiar) costs no slot; any other spends the one named.
export type CompanionMagicCommand =
  | { readonly kind: "summonCompanion"; readonly characterId: CharacterId; readonly spellId: ContentId<"spell">; readonly slotLevel: number }
  | { readonly kind: "dismissCompanion"; readonly characterId: CharacterId; readonly companionId: string };

// A spell that brings a fallen hero back (Revivify and the spells above it), cast between fights (engine/revival-magic.ts): spends the slot named.
export type RevivalMagicCommand = {
  readonly kind: "castReviveSpell";
  readonly characterId: CharacterId;
  readonly targetId: CharacterId;
  readonly spellId: ContentId<"spell">;
  readonly slotLevel: number;
};

// A slotted healing spell on a friend outside combat (engine/healing-magic.ts):
// spends the slot the hero names and heals by the spell's own dice.
export type HealingMagicCommand = {
  readonly kind: "castHealingSpell";
  readonly characterId: CharacterId;
  readonly targetId: CharacterId;
  readonly spellId: ContentId<"spell">;
  readonly slotLevel: number;
};

// A travel or environmental hazard outside combat (engine/travel.ts):
// forced marches, extreme weather, harsh terrain — the organizer names the
// ability it tests and its DC (the engine has no bible to look either up
// from), and a real saving throw, not narrative fiat, decides whether the
// hero gains a level of Exhaustion for it (SRD's own default cost).
export type TravelCommand =
  | { readonly kind: "faceHazard"; readonly characterId: CharacterId; readonly ability: Ability; readonly dc: number }
  | { readonly kind: "recordHazardNarration"; readonly hazardId: string; readonly text: string }
  // Damage between fights (engine/environmental-damage.ts): a fall (1d6 bludgeoning for each 10 feet, up to 20d6), drowning or suffocation
  // (a hero drops to 0 hit points; one already there dies), or any other dice of damage the organizer names.
  | { readonly kind: "takeEnvironmentalDamage"; readonly characterId: CharacterId; readonly source: EnvironmentalDamageSource };

export type EnvironmentalDamageSource =
  | { readonly kind: "fall"; readonly feet: number }
  | { readonly kind: "suffocation" }
  | { readonly kind: "damage"; readonly count: number; readonly sides: 4 | 6 | 8 | 10 | 12; readonly damageType: DamageType };

// Items move between heroes outside combat. The owner of the giving hero
// offers, the owner of the receiving hero answers; the stash is shared.
export type InventoryCommand =
  | {
      readonly kind: "offerItem";
      readonly fromCharacterId: CharacterId;
      readonly toCharacterId: CharacterId;
      readonly give: ContentId<"item">;
      // Null: a gift. Otherwise the item asked for in return.
      readonly want: ContentId<"item"> | null;
    }
  | { readonly kind: "respondToOffer"; readonly offerId: string; readonly accept: boolean }
  | { readonly kind: "cancelOffer"; readonly offerId: string }
  | { readonly kind: "stashItem"; readonly characterId: CharacterId; readonly itemId: ContentId<"item"> }
  // The hero's owner, or the organizer, takes an item out of the stash for a hero.
  | { readonly kind: "takeFromStash"; readonly characterId: CharacterId; readonly itemId: ContentId<"item"> }
  // Outside combat: the hero drinks a potion they hold.
  | { readonly kind: "useItem"; readonly characterId: CharacterId; readonly itemId: ContentId<"item"> }
  // Outside combat (armor takes minutes to change in the 2014 rules): the
  // hero puts on, or takes off, an armor or shield they carry.
  | { readonly kind: "wearItem"; readonly characterId: CharacterId; readonly itemId: ContentId<"item"> }
  | { readonly kind: "removeItem"; readonly characterId: CharacterId; readonly itemId: ContentId<"item"> };

// Combat. Hero commands name the acting combatant (the hero's character ID)
// so a stale button for another turn is refused rather than misapplied.
export type CombatCommand =
  | { readonly kind: "startEncounter"; readonly spec: EncounterSpec }
  | { readonly kind: "combatMove"; readonly combatantId: string; readonly zoneId: string }
  | { readonly kind: "combatEngage"; readonly combatantId: string; readonly targetId: string }
  | { readonly kind: "combatWithdraw"; readonly combatantId: string }
  // smiteSlot: spend this spell slot on the hit for Divine Smite's bonus damage.
  | { readonly kind: "combatAttack"; readonly combatantId: string; readonly targetId: string; readonly weapon: ContentId<"item">; readonly smiteSlot?: number; readonly offHand?: true; readonly nonlethal?: true }
  | {
      readonly kind: "combatCast";
      readonly combatantId: string;
      readonly spellId: ContentId<"spell">;
      // 0 for cantrips.
      readonly slotLevel: number;
      readonly targetIds: readonly string[];
      // The zone a teleporting spell is aimed at (Misty Step).
      readonly zoneId?: string;
    }
  | { readonly kind: "combatUseFeature"; readonly combatantId: string; readonly featureId: ContentId<"feature"> }
  | { readonly kind: "combatUseItem"; readonly combatantId: string; readonly itemId: ContentId<"item"> }
  // Putting on or taking off a shield costs an action (2014 rules); armor cannot be changed in a fight.
  | { readonly kind: "combatShield"; readonly combatantId: string; readonly itemId: ContentId<"item">; readonly on: boolean }
  | { readonly kind: "combatDisengage"; readonly combatantId: string }
  | { readonly kind: "combatDash"; readonly combatantId: string }
  | { readonly kind: "combatDodge"; readonly combatantId: string }
  // Wild Shape: borrows a beast's stat block (monsterId) as a bonus action,
  // or (monsterId omitted) reverts to the hero's own, stashed while shaped.
  | { readonly kind: "combatWildShape"; readonly combatantId: string; readonly monsterId?: ContentId<"monster"> }
  | { readonly kind: "endTurn"; readonly combatantId: string }
  // The target of a hit answers the reaction window: cast a reaction spell (Shield), or decline (null).
  | { readonly kind: "combatReact"; readonly combatantId: string; readonly spellId: ContentId<"spell"> | null }
  // A provoker answers whether they take the opportunity attack a mover's
  // move offered them.
  | { readonly kind: "combatOpportunityAttack"; readonly combatantId: string; readonly take: boolean }
  // The attacker of a landed hit answers the smite window: spend this slot
  // for Divine Smite's bonus damage, or skip it (null).
  | { readonly kind: "combatSmite"; readonly combatantId: string; readonly slotLevel: number | null }
  | { readonly kind: "turnTimerExpired"; readonly encounterId: string; readonly turnNumber: number }
  // A reaction window ran out of time: the target declines.
  | { readonly kind: "reactionTimerExpired"; readonly encounterId: string; readonly resolutionId: string }
  // A smite window ran out of time: the attacker skips it.
  | { readonly kind: "smiteTimerExpired"; readonly encounterId: string; readonly resolutionId: string }
  // An opportunity attack offer ran out of time: the provoker declines (holds the reaction).
  | { readonly kind: "opportunityAttackTimerExpired"; readonly encounterId: string; readonly combatantId: string };

export interface EncounterSpec {
  readonly id: string;
  // lighting: bright when absent. In a dark zone a creature without darkvision cannot see, and attacks in or into it at disadvantage.
  readonly zones: readonly { readonly id: string; readonly name: string; readonly lighting?: "bright" | "dim" | "dark"; readonly cover?: "half" | "three-quarters"; readonly difficult?: boolean }[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly feet: number }[];
  readonly partyZoneId: string;
  // Which side is taken by surprise: it cannot act or react until its first turn has passed. Absent: nobody.
  readonly surprised?: "party" | "foes" | undefined;
  readonly monsters: readonly EncounterMonster[];
  // Added to the party stash on a victory. Absent: none.
  readonly loot?: readonly ContentId<"item">[];
  readonly gold?: number;
  // A victory here raises the party to this level at a milestone table (the
  // adventure's own story beat). Ignored where XP levels the party.
  readonly milestoneLevel?: number;
  // Beats inside the fight: each fires once, the first time its condition holds. Absent: none.
  readonly triggers?: readonly EncounterTrigger[];
  // Story effects applied when the party wins (after the loot and experience). Absent: none.
  readonly onVictory?: readonly PartyEffect[];
  // Foes lying in wait: unless some hero's passive Perception reaches this, the party is taken by surprise.
  readonly ambush?: { readonly dc: number };
  // Something dreadful as the fight breaks out: every hero saves against it, and one who fails is frightened until their first turn ends.
  readonly dread?: { readonly ability: Ability; readonly dc: number };
}

// What can happen inside a fight: any story effect except starting another fight, plus foes arriving, the fight ending in the
// party's favour (a truce: the rest of the foes stand down), and a line the table sees.
export type FightEffect =
  | Exclude<PartyEffect, { readonly kind: "startEncounter" | "advanceClock" }>
  | { readonly kind: "addMonsters"; readonly monsters: readonly EncounterMonster[] }
  | { readonly kind: "endFight" }
  | { readonly kind: "announce"; readonly text: string };

export interface EncounterTrigger {
  // foesDown: this many foes are dead or knocked out. round: the fight has reached this round.
  readonly when: { readonly kind: "foesDown"; readonly count: number } | { readonly kind: "round"; readonly round: number };
  readonly effects: readonly FightEffect[];
}

// What an adventure changes about a borrowed stat block: a tougher or weaker version of an SRD monster. Bonuses are added to every attack.
export interface MonsterStats {
  readonly hp?: number;
  readonly armorClass?: number;
  readonly toHit?: number;
  readonly damage?: number;
}

export interface EncounterMonster {
  readonly monsterId: ContentId<"monster">;
  readonly zoneId: string;
  // A named NPC this monster plays, e.g. npc:skarn.
  readonly npcId: string | null;
  readonly fleeBelowHpFraction: number | null;
  readonly stats?: MonsterStats;
}

export interface RecordLedgerFactCommand {
  readonly kind: "recordLedgerFact";
  readonly entityId: string;
  readonly canonicalName: string;
  readonly fact: string;
  readonly visibility: LedgerVisibility;
}

export type CampaignCommandKind = CampaignCommand["kind"];

// The Planner's structured proposal for a closed round, validated by the
// engine before anything applies. Clarification, conflicts, and
// dependencies join this shape later.
export interface RoundPlanProposal {
  readonly roundNumber: number;
  readonly actions: readonly PlannedAction[];
  // Applied once the round's checks resolve, before narration. Absent: none.
  readonly effects?: readonly PlannedEffect[];
}

// A story effect and when it fires (plan §6: effects keyed by outcome, so no
// second model call is needed after the roll).
export interface PlannedEffect {
  readonly effect: StoryEffect;
  readonly when: EffectCondition;
  // A scene change the story itself makes (an authored result, a trapdoor)
  // happens at once. Without this, a move the Planner proposes waits for the
  // table: silence agrees, and a majority pressing Stay stops it.
  readonly forced?: boolean;
  // This effect is part of arriving in that scene (its onEnter effects), so it
  // waits with the move instead of happening before the party gets there.
  readonly arrivalOf?: SceneId;
  // On a Planner's move: the heroes whose actions head there. Fewer than half of those who acted and the move is not proposed.
  readonly movers?: readonly CharacterId[];
}

// The application resolves authored IDs (encounters) to their definitions
// before the proposal reaches the engine, which validates the result.
export type StoryEffect =
  | { readonly kind: "transitionScene"; readonly sceneId: SceneId }
  | { readonly kind: "startEncounter"; readonly encounter: EncounterSpec }
  // Ticks a skill-challenge clock. The application resolves the clock's
  // size and the fight it starts when full from the adventure.
  | {
      readonly kind: "advanceClock";
      readonly clockId: string;
      readonly segments: number;
      readonly by: number;
      readonly onFull: EncounterSpec | null;
    }
  | { readonly kind: "revealClue"; readonly clueId: string; readonly text: string }
  // Sets a story flag: a fact later story text can require. Idempotent.
  | { readonly kind: "setFlag"; readonly flag: string; readonly value: number }
  // Gold and items the party is given, once: a second grant with the same rewardId does nothing.
  | { readonly kind: "grantReward"; readonly rewardId: string; readonly gold: number; readonly items: readonly ContentId<"item">[] }
  // The hero pays gold (their own share, or the party purse) for what the story sells; nothing happens if they cannot.
  | { readonly kind: "spendGold"; readonly characterId: CharacterId; readonly amount: number }
  // A line the table sees, once: a second notice with the same id does nothing.
  | { readonly kind: "notice"; readonly noticeId: string; readonly text: string }
  // A story object the party now carries (a token, a letter), with the name and words the table knows it by. Once per id.
  | { readonly kind: "grantKeepsake"; readonly keepsake: Keepsake }
  // Time passes in the story by this many phases of the day (six make a day). Ignored when the adventure has no clock.
  | { readonly kind: "advanceTime"; readonly steps: number }
  // The sky changes.
  | { readonly kind: "setWeather"; readonly weather: Weather }
  // Harm to one hero between fights (a trap, foul water): the dice decide how much. Not available inside a fight.
  | { readonly kind: "hurt"; readonly characterId: CharacterId; readonly count: number; readonly sides: 4 | 6 | 8 | 10 | 12; readonly damageType: DamageType };

// The effects that need no more than the shared state, so a fight's beats and a victory can use them too (hurt is a between-fights rule).
export type PartyEffect = Exclude<StoryEffect, { readonly kind: "hurt" }>;

export type EffectCondition =
  | { readonly kind: "always" }
  // Fires on the outcome of this hero's check this round.
  | { readonly kind: "checkOutcome"; readonly characterId: CharacterId; readonly success: boolean }
  // A group check: it succeeds when at least half of the round's checks did (the SRD's rule for the whole party attempting one thing).
  | { readonly kind: "groupCheck"; readonly success: boolean }
  // Several heroes tried the same thing: success when any of their checks did (reaching atLeast, when given), failure when none did.
  | { readonly kind: "anyCheck"; readonly characterIds: readonly CharacterId[]; readonly success: boolean; readonly atLeast?: number };

export interface PlannedAction {
  readonly characterId: CharacterId;
  readonly resolution: PlannedResolution;
}

export type PlannedResolution =
  | { readonly kind: "automatic"; readonly reason: string }
  | { readonly kind: "impossible"; readonly reason: string }
  | {
      readonly kind: "check";
      readonly test: CheckTest;
      readonly dcTier: DcTier;
      // An authored difficulty (an adventure's own DC 11, say) in place of the tier's; 1 to 30.
      readonly dc?: number;
      readonly rollModeReasons: readonly RollModeReason[];
    };
