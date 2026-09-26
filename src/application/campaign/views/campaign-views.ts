import type { AdventureBible } from "../../../domain/campaign/adventure/adventure-bible.js";
import { findScene } from "../../../domain/campaign/adventure/adventure-bible.js";
import { abilityModifier, type CharacterSheet } from "../../../domain/campaign/character/character-sheet.js";
import { armorClassFrom, heroTraits } from "../../../domain/campaign/combat/combatant-profile.js";
import type { Combatant } from "../../../domain/campaign/combat/combat-state.js";
import type { Glossary, SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import { isFallen, type CampaignState, type Submission } from "../../../domain/campaign/state/campaign-state.js";
import { activeMembers, readyToStart, type LobbyMember } from "../../../domain/campaign/lobby/lobby.js";
import { combatantName, type CombatNames } from "../dm/combat-records.js";
import type { CampaignRecord } from "../ports/campaign-record.js";

// What the table is shown, as plain data. The Discord renderers turn these
// into localized messages; nothing here knows about Discord or a language, so
// the same views serve any presentation and are easy to test.

export type RosterStatus = "submitted" | "passed" | "thinking" | "away" | "missed";

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
}

export type PanelMode =
  | "collecting"
  | "planning"
  | "awaitingRolls"
  | "combat"
  | "waiting"
  | "paused"
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
  readonly party: readonly { readonly name: string; readonly hp: number; readonly maxHp: number; readonly condition: Combatant["condition"] }[];
  // Monsters show a health band, never exact HP.
  readonly foes: readonly { readonly name: string; readonly band: "unhurt" | "hurt" | "bloodied" | "down" }[];
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
      return { userId: member.userId, status: member.status, heroName: preset?.name ?? null, className: preset?.className ?? null };
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
  const armorClass = fighter?.armorClass ?? armorClassFrom(heroTraits(sheet, content), abilityModifier(sheet.abilityScores.dex));
  const member = state.members[sheet.ownerUserId];
  return {
    characterId: sheet.id,
    ownerUserId: sheet.ownerUserId,
    name: sheet.name,
    className: sheet.className ?? null,
    level: sheet.level,
    hp,
    maxHp: sheet.maxHp,
    armorClass,
    conditions: fighter?.conditions ?? [],
    presence: member?.availability ?? "away",
    down: hp <= 0,
    fallen: isFallen(state, sheet.id),
  };
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
    combat: fight === null ? null : combatViewOf({ state, bible, glossary }, fight),
  };
}

function modeOf(record: CampaignRecord, state: CampaignState, inFight: boolean, rollsPending: boolean): PanelMode {
  if (record.lifecycle === "archived") return "archived";
  if (state.pausedBy === "recovery") return "recovery";
  if (state.pausedBy === "organizer" || record.lifecycle === "paused") return "paused";
  if (state.status === "waitingForPlayers") return "waiting";
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
    return [{ characterId, userId: sheet.ownerUserId, heroName: sheet.name, status: rosterStatus(round?.submissions[characterId], away) }];
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

function combatViewOf(names: CombatNames, fight: NonNullable<CampaignState["encounter"]>): CombatView {
  const combatants = Object.values(fight.combatants);
  const current = fight.order[fight.turnIndex];
  const name = (combatant: Combatant): string => combatantName(combatant, names);
  return {
    round: fight.round,
    activeName: current === undefined || fight.combatants[current] === undefined ? null : name(fight.combatants[current]),
    party: combatants
      .filter((combatant) => combatant.side === "party")
      .map((combatant) => ({ name: name(combatant), hp: combatant.hp, maxHp: combatant.maxHp, condition: combatant.condition })),
    foes: combatants
      .filter((combatant) => combatant.side === "foes")
      .map((combatant) => ({
        name: name(combatant),
        band: combatant.hp <= 0 ? "down" : combatant.hp >= combatant.maxHp ? "unhurt" : combatant.hp * 2 > combatant.maxHp ? "hurt" : "bloodied",
      })),
  };
}
