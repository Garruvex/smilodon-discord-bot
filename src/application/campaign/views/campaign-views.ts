import { conditionLookup, conditionsOf } from "../../../domain/campaign/effects/effect-queries.js";
import { featureUsesOf } from "../../../domain/campaign/rules/content-definitions.js";
import type { AdventureBible } from "../../../domain/campaign/adventure/adventure-bible.js";
import { findScene } from "../../../domain/campaign/adventure/adventure-bible.js";
import { abilityModifier, type CharacterSheet } from "../../../domain/campaign/character/character-sheet.js";
import { armorClassFrom, heroTraits, isWorn, unarmoredModifier } from "../../../domain/campaign/combat/combatant-profile.js";
import type { Combatant } from "../../../domain/campaign/combat/combat-state.js";
import type { Glossary, SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import { isFallen, type CampaignState, type Submission } from "../../../domain/campaign/state/campaign-state.js";
import { activeMembers, readyToStart, type LobbyMember } from "../../../domain/campaign/lobby/lobby.js";
import { combatantName, type CombatNames } from "../dm/combat-records.js";
import type { CampaignRecord } from "../ports/campaign-record.js";
import { combatMode } from "../../../domain/campaign/rules/house-rules.js";

const combatModeId = combatMode.id;

// What the table is shown, as plain data. The Discord renderers turn these
// into localized messages; nothing here knows about Discord or a language, so
// the same views serve any presentation and are easy to test.

export type RosterStatus = "submitted" | "passed" | "thinking" | "away" | "missed" | "ready";

export interface HeroView {
  readonly characterId: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly className: string | null;
  readonly level: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly armorClass: number;
  // Condition IDs, e.g. condition:prone; localized by the renderer.
  readonly conditions: readonly string[];
  readonly presence: "present" | "away";
  readonly down: boolean;
  readonly fallen: boolean;
  // The armor and shield worn, and the weapons carried (drawn as needed).
  readonly worn: readonly string[];
  readonly weapons: readonly string[];
  // Everything else carried: potions and spare armor, with how many.
  readonly pack: readonly { readonly id: string; readonly count: number }[];
  // The hero's own coins, the party purse, and the loot the party holds in common.
  readonly gold: number;
  readonly partyGold: number;
  readonly stash: readonly string[];
  // Spellcasters: cantrips, prepared spells, and slots left of each level.
  readonly cantrips: readonly string[];
  readonly prepared: readonly string[];
  readonly slots: readonly { readonly level: number; readonly left: number; readonly max: number }[];
  // A Warlock's separate Pact Magic pool (always its own level, recovers on
  // a short rest), shown apart from slots since the two never share a count.
  readonly pactSlots: readonly { readonly level: number; readonly left: number; readonly max: number }[];
  // Limited-use features (Second Wind) with uses left.
  readonly uses: readonly { readonly id: string; readonly left: number; readonly max: number }[];
}

export type PanelMode =
  | "opening"
  | "readyCheck"
  | "collecting"
  | "planning"
  | "awaitingRolls"
  | "combat"
  | "waiting"
  | "paused"
  | "safety"
  | "recovery"
  | "archived";

export interface RosterEntry {
  readonly characterId: string;
  readonly userId: string;
  readonly heroName: string;
  readonly status: RosterStatus;
}

export interface CombatView {
  readonly round: number;
  readonly activeName: string | null;
  // Whose turn it is, when a player's hero has it.
  readonly activeUserId: string | null;
  // Players take their heroes' turns (false: the engine plays them on autopilot).
  readonly playersControl: boolean;
  // The battlefield's zones in order; each combatant says which it stands in.
  readonly zones: readonly string[];
  readonly party: readonly {
    readonly name: string;
    readonly hp: number;
    readonly maxHp: number;
    readonly condition: Combatant["condition"];
    readonly zone: string;
    readonly active: boolean;
  }[];
  // Monsters show a health band, never exact HP.
  readonly foes: readonly {
    readonly name: string;
    readonly band: "unhurt" | "hurt" | "bloodied" | "down";
    readonly zone: string;
    readonly active: boolean;
  }[];
}

// An item one hero offers another, waiting for an answer.
export interface OfferView {
  readonly id: string;
  readonly fromName: string;
  readonly toName: string;
  readonly toUserId: string;
  readonly give: string;
  readonly want: string | null;
}

// A hit waiting on its target's reaction (Shield): the attack that landed,
// who it's on, and what they could cast to still turn it into a miss.
export interface ReactionView {
  readonly attackerName: string;
  readonly targetName: string;
  readonly targetUserId: string;
  // The attack roll that landed; null when the window is about a spell being cast or damage just dealt.
  readonly natural: number | null;
  readonly total: number | null;
  // What opened the window: a hit (Shield), a spell being cast (Counterspell), or damage dealt (Hellish Rebuke).
  readonly trigger: "hit" | "spell" | "damage";
  // For a spell being cast, its name.
  readonly spellName: string | null;
  readonly options: readonly { readonly spellId: string; readonly spellName: string; readonly slotLevel: number }[];
  // Milliseconds since epoch the window closes at; null when play has no timers.
  readonly closesAt: number | null;
}

// A landed weapon hit waiting on its attacker's Divine Smite answer: never
// changes whether the hit lands, only whether bonus damage follows it.
export interface SmiteView {
  readonly attackerName: string;
  readonly attackerUserId: string;
  readonly targetName: string;
  readonly options: readonly { readonly slotLevel: number }[];
  readonly closesAt: number | null;
}

// A mover leaving a hostile creature's reach waits on that creature's
// player: take the opportunity attack (spending the reaction), or hold it.
export interface OpportunityAttackView {
  readonly moverName: string;
  readonly provokerName: string;
  readonly provokerUserId: string;
  readonly closesAt: number | null;
}

export interface PanelView {
  readonly campaignName: string;
  readonly sceneTitle: string;
  readonly mode: PanelMode;
  readonly roundNumber: number | null;
  // When the current window or turn closes; null means no timer.
  readonly closesAt: number | null;
  readonly roster: readonly RosterEntry[];
  // Heroes whose check is waiting for a click (or its auto-roll).
  readonly pendingRolls: readonly { readonly characterId: string; readonly userId: string; readonly heroName: string }[];
  readonly combat: CombatView | null;
}

export type LobbyMissing = "notEnoughPlayers" | "notReady" | null;

export interface LobbyMemberView {
  readonly userId: string;
  readonly status: LobbyMember["status"];
  readonly heroName: string | null;
  readonly className: string | null;
}

export interface LobbyView {
  readonly campaignName: string;
  readonly adventureTitle: string;
  readonly language: CampaignRecord["language"];
  readonly organizerId: string;
  readonly pacingPreset: CampaignRecord["pacingPreset"];
  readonly members: readonly LobbyMemberView[];
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly open: boolean;
  readonly canJoin: boolean;
  readonly missing: LobbyMissing;
}

export interface PresetSummary {
  readonly id: string;
  readonly name: string;
  readonly className: string;
}

export function buildLobbyView(record: CampaignRecord, adventureTitle: string, presets: readonly PresetSummary[]): LobbyView {
  const { lobby } = record;
  const active = activeMembers(lobby);
  const problem = readyToStart(lobby);
  return {
    campaignName: record.name,
    adventureTitle,
    language: record.language,
    organizerId: record.organizerId,
    pacingPreset: record.pacingPreset,
    members: active.map((member) => {
      const preset = presets.find((candidate) => candidate.id === member.heroId);
      return { userId: member.userId, status: member.status, heroName: member.label?.name ?? preset?.name ?? null, className: member.label?.className ?? preset?.className ?? null };
    }),
    minPlayers: lobby.minPlayers,
    maxPlayers: lobby.maxPlayers,
    open: lobby.status === "open",
    canJoin: lobby.status === "open" && active.length < lobby.maxPlayers,
    missing: problem === "notEnoughPlayers" || problem === "notReady" ? problem : null,
  };
}

export function buildHeroView(state: CampaignState, sheet: CharacterSheet, content: SealedContent): HeroView {
  const fighter = state.encounter !== null && state.encounter.status !== "ended" ? state.encounter.combatants[sheet.id] : undefined;
  const hp = fighter?.hp ?? state.heroStatus[sheet.id]?.hp ?? sheet.maxHp;
  const armorClass = fighter?.armorClass ?? armorClassFrom(heroTraits(sheet, content), abilityModifier(sheet.abilityScores.dex), unarmoredModifier(heroTraits(sheet, content), sheet.abilityScores));
  const member = state.members[sheet.ownerUserId];
  const resources = fighter?.resources ?? state.heroStatus[sheet.id]?.resources;

  const worn: string[] = [];
  const weapons: string[] = [];
  const pack = new Map<string, number>();
  for (const id of sheet.equipment) {
    const definition = content.find(id);
    const type = definition?.kind === "item" ? definition.itemType : null;
    if (type === "weapon") weapons.push(id);
    else if ((type === "armor" || type === "shield") && isWorn(sheet, content, id)) worn.push(id);
    else pack.set(id, (pack.get(id) ?? 0) + 1);
  }
  const cantrips: string[] = [];
  const prepared: string[] = [];
  for (const id of sheet.spellcasting?.spells ?? []) {
    const definition = content.find(id);
    (definition?.kind === "spell" && definition.level === 0 ? cantrips : prepared).push(id);
  }
  const slots = Object.entries(sheet.spellcasting?.slots ?? {})
    .map(([level, max]) => ({ level: Number(level), left: Math.min(max, resources?.spellSlots[Number(level)] ?? max), max }))
    .filter((slot) => slot.max > 0)
    .sort((a, b) => a.level - b.level);
  const pactSlots = Object.entries(sheet.pactMagic?.slots ?? {})
    .map(([level, max]) => ({ level: Number(level), left: Math.min(max, resources?.pactSlots?.[Number(level)] ?? max), max }))
    .filter((slot) => slot.max > 0)
    .sort((a, b) => a.level - b.level);
  const uses = sheet.features.flatMap((id) => {
    const definition = content.find(id);
    const held = definition?.kind === "feature" ? featureUsesOf(definition, sheet.level) : null;
    if (held === null) return [];
    const max = held.count;
    return [{ id, left: Math.min(max, resources?.featureUses[id] ?? max), max }];
  });
  return {
    characterId: sheet.id,
    ownerUserId: sheet.ownerUserId,
    name: sheet.name,
    className: sheet.className ?? null,
    level: sheet.level,
    hp,
    maxHp: sheet.maxHp,
    armorClass,
    conditions: fighter === undefined ? [] : conditionsOf(fighter, conditionLookup(content)),
    presence: member?.availability ?? "away",
    down: hp <= 0,
    fallen: isFallen(state, sheet.id),
    worn,
    weapons,
    pack: [...pack].map(([id, count]) => ({ id, count })),
    gold: state.heroGold?.[sheet.id] ?? 0,
    partyGold: state.gold,
    stash: state.stash,
    cantrips,
    prepared,
    slots,
    pactSlots,
    uses,
  };
}

// The hit waiting on a reaction right now, if any (at most one at a time:
// resolution stalls on it before anything else can proceed).
export function buildReactionView(state: CampaignState, bible: AdventureBible, glossary: Glossary): ReactionView | null {
  const encounter = state.encounter;
  const resolution = encounter?.resolution;
  const pending = resolution?.reaction;
  if (encounter == null || resolution == null || pending == null) return null;
  const attacker = encounter.combatants[resolution.actorId];
  const target = encounter.combatants[pending.targetId];
  const targetSheet = target?.source.kind === "hero" ? state.characters[target.source.characterId] : undefined;
  if (attacker === undefined || target === undefined || targetSheet === undefined) return null;
  const names: CombatNames = { state, bible, glossary };
  return {
    attackerName: combatantName(attacker, names),
    targetName: combatantName(target, names),
    targetUserId: targetSheet.ownerUserId,
    natural: pending.roll?.d20.natural ?? null,
    total: pending.roll?.total ?? null,
    trigger: pending.trigger ?? "hit",
    spellName: pending.spellId === undefined ? null : (glossary.names[pending.spellId] ?? pending.spellId),
    options: pending.options.map((option) => ({ spellId: option.spellId, spellName: glossary.names[option.spellId] ?? option.spellId, slotLevel: option.slotLevel })),
    closesAt: pending.closesAt,
  };
}

// The landed hit waiting on a smite answer right now, if any (at most one at
// a time, the same as a reaction: resolution stalls on it before anything
// else can proceed). The attacker is a hero (only a player-controlled
// attacker is ever offered the choice — engine/combat/smite.ts's offerSmite).
export function buildSmiteView(state: CampaignState, bible: AdventureBible, glossary: Glossary): SmiteView | null {
  const encounter = state.encounter;
  const resolution = encounter?.resolution;
  const pending = resolution?.smite;
  if (encounter == null || resolution == null || pending == null) return null;
  const attacker = encounter.combatants[resolution.actorId];
  const target = encounter.combatants[pending.targetId];
  const attackerSheet = attacker?.source.kind === "hero" ? state.characters[attacker.source.characterId] : undefined;
  if (attacker === undefined || target === undefined || attackerSheet === undefined) return null;
  const names: CombatNames = { state, bible, glossary };
  return {
    attackerName: combatantName(attacker, names),
    attackerUserId: attackerSheet.ownerUserId,
    targetName: combatantName(target, names),
    options: pending.options,
    closesAt: pending.closesAt,
  };
}

// The opportunity attack waiting on a provoker's answer right now, if any
// (at most one at a time: the mover's move waits on the whole provokers
// queue in order, one offer open at a time — engine/combat/movement.ts).
export function buildOpportunityAttackView(state: CampaignState, bible: AdventureBible, glossary: Glossary): OpportunityAttackView | null {
  const encounter = state.encounter;
  const move = encounter?.pendingMove;
  const offer = move?.offer;
  const provokerId = move?.provokers[0];
  if (encounter == null || move == null || offer == null || provokerId === undefined) return null;
  const mover = encounter.combatants[move.combatantId];
  const provoker = encounter.combatants[provokerId];
  const provokerSheet = provoker?.source.kind === "hero" ? state.characters[provoker.source.characterId] : undefined;
  if (mover === undefined || provoker === undefined || provokerSheet === undefined) return null;
  const names: CombatNames = { state, bible, glossary };
  return {
    moverName: combatantName(mover, names),
    provokerName: combatantName(provoker, names),
    provokerUserId: provokerSheet.ownerUserId,
    closesAt: offer.closesAt,
  };
}

// The offers still open, oldest first.
export function buildOfferViews(state: CampaignState): readonly OfferView[] {
  return Object.values(state.offers).flatMap((offer) => {
    const from = state.characters[offer.fromCharacterId];
    const to = state.characters[offer.toCharacterId];
    return from === undefined || to === undefined ? [] : [{ id: offer.id, fromName: from.name, toName: to.name, toUserId: to.ownerUserId, give: offer.give, want: offer.want }];
  });
}

// The heroes players currently control, in party order.
export function buildPartyView(state: CampaignState, content: SealedContent): readonly HeroView[] {
  return Object.values(state.members).flatMap((member) => {
    const sheet = member.characterId === null ? undefined : state.characters[member.characterId];
    return sheet === undefined ? [] : [buildHeroView(state, sheet, content)];
  });
}

export function buildPanelView(record: CampaignRecord, state: CampaignState, bible: AdventureBible, glossary: Glossary): PanelView {
  const roster = rosterOf(state);
  const scene = findScene(bible, state.sceneId);
  const fight = state.encounter !== null && state.encounter.status !== "ended" ? state.encounter : null;
  const pendingRolls = Object.values(state.checks)
    .filter((check) => check.status === "pending" || check.status === "rolling")
    .map((check) => ({
      characterId: check.characterId,
      userId: state.characters[check.characterId]?.ownerUserId ?? "",
      heroName: state.characters[check.characterId]?.name ?? check.characterId,
    }));
  return {
    campaignName: record.name,
    sceneTitle: scene?.title ?? bible.title,
    mode: modeOf(record, state, fight !== null, pendingRolls.length > 0),
    roundNumber: fight?.round ?? state.round?.number ?? null,
    closesAt: fight?.turnEndsAt ?? state.round?.closesAt ?? null,
    roster,
    pendingRolls,
    combat: fight === null ? null : combatViewOf({ state, bible, glossary }, fight, record.houseRules[combatModeId] !== "autopilot"),
  };
}

function modeOf(record: CampaignRecord, state: CampaignState, inFight: boolean, rollsPending: boolean): PanelMode {
  if (record.lifecycle === "archived") return "archived";
  if (state.pausedBy === "recovery") return "recovery";
  if (state.pausedBy === "safety") return "safety";
  if (state.pausedBy === "organizer" || record.lifecycle === "paused") return "paused";
  if (state.status === "waitingForPlayers") return "waiting";
  if (state.opening === "pending") return "opening";
  if (state.opening === "waiting") return "readyCheck";
  if (inFight) return "combat";
  if (state.round?.status === "collecting") return "collecting";
  if (state.round?.status === "resolving" && rollsPending) return "awaitingRolls";
  return "planning";
}

function rosterOf(state: CampaignState): readonly RosterEntry[] {
  const round = state.round;
  const participants = round?.participants ?? Object.values(state.members).flatMap((member) => (member.characterId === null ? [] : [member.characterId]));
  return participants.flatMap((characterId) => {
    const sheet = state.characters[characterId];
    if (sheet === undefined) return [];
    const away = state.members[sheet.ownerUserId]?.availability === "away";
    const ready = state.opening === "waiting" ? (state.openingReady ?? []).includes(sheet.ownerUserId) : false;
    const status = state.opening === "waiting" ? (away ? "away" : ready ? "ready" : "thinking") : rosterStatus(round?.submissions[characterId], away);
    return [{ characterId, userId: sheet.ownerUserId, heroName: sheet.name, status }];
  });
}

function rosterStatus(submission: Submission | undefined, away: boolean): RosterStatus {
  switch (submission?.kind) {
    case "action":
      return "submitted";
    case "pass":
      return "passed";
    case "missed":
      return "missed";
    case "excused":
      return "away";
    default:
      return away ? "away" : "thinking";
  }
}

function combatViewOf(names: CombatNames, fight: NonNullable<CampaignState["encounter"]>, playersControl: boolean): CombatView {
  const combatants = Object.values(fight.combatants);
  const current = fight.order[fight.turnIndex];
  const name = (combatant: Combatant): string => combatantName(combatant, names);
  const zoneName = (zoneId: string): string => fight.zones.find((zone) => zone.id === zoneId)?.name ?? zoneId;
  const active = fight.status === "active" && current !== undefined ? fight.combatants[current] : undefined;
  const owner = active?.source.kind === "hero" ? names.state.characters[active.source.characterId]?.ownerUserId ?? null : null;
  return {
    round: fight.round,
    activeName: active === undefined ? null : name(active),
    activeUserId: owner,
    playersControl,
    zones: fight.zones.map((zone) => zone.name),
    party: combatants
      .filter((combatant) => combatant.side === "party")
      .map((combatant) => ({ name: name(combatant), hp: combatant.hp, maxHp: combatant.maxHp, condition: combatant.condition, zone: zoneName(combatant.zoneId), active: combatant === active })),
    foes: combatants
      .filter((combatant) => combatant.side === "foes")
      .map((combatant) => ({
        name: name(combatant),
        band: combatant.hp <= 0 ? "down" : combatant.hp >= combatant.maxHp ? "unhurt" : combatant.hp * 2 > combatant.maxHp ? "hurt" : "bloodied",
        zone: zoneName(combatant.zoneId),
        active: combatant === active,
      })),
  };
}
