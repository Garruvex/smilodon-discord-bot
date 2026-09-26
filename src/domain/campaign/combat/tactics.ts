import type { AttackOption, Combatant, CombatantId, EncounterState, ZoneId } from "./combat-state.js";
import { engagedWith, isActive } from "./combat-state.js";
import { distanceBetween, edgeBetween, engageCost, shortestPath } from "./positioning.js";

// What a combatant not driven by a player does this turn, chosen by plain
// rules with no model call (plan §6, NPCs and monsters in combat). Pure:
// the combat engine executes the plan through its normal, validated steps.
export interface TurnPlan {
  // Nimble Escape: Disengage as a bonus action before moving.
  readonly disengage: boolean;
  readonly dash: boolean;
  readonly moves: readonly ZoneId[];
  readonly engage: CombatantId | null;
  readonly attack: { readonly targetId: CombatantId; readonly option: AttackOption } | null;
  readonly dodge: boolean;
}

const idle: TurnPlan = { disengage: false, dash: false, moves: [], engage: null, attack: null, dodge: false };

// Monsters leave downed heroes alone by default (plan §6: focus-firing
// unconscious heroes is off unless a house rule enables it).
export function chooseMonsterPlan(encounter: EncounterState, monster: Combatant): TurnPlan {
  const foes = hostiles(encounter, monster);
  if (foes.length === 0) return idle;
  const melee = monster.attacks.find((attack) => attack.range.kind === "melee") ?? null;
  const ranged = monster.attacks.find((attack) => attack.range.kind === "ranged") ?? null;
  const engaged = engagedWith(encounter, monster.id).filter((other) => other.side !== monster.side && isActive(other));

  // Skirmishers with Nimble Escape slip out of melee and shoot.
  if (monster.tactic === "skirmisher" && engaged.length > 0 && ranged !== null && monster.traits.some((trait) => trait.kind === "nimbleEscape")) {
    const retreat = retreatZone(encounter, monster);
    if (retreat !== null) {
      const moved = { ...encounter, combatants: { ...encounter.combatants, [monster.id]: { ...monster, zoneId: retreat } }, engagements: [] };
      const target = pickTarget(moved, { ...monster, zoneId: retreat }, foes.filter((foe) => inRange(moved, { ...monster, zoneId: retreat }, foe, ranged)));
      if (target !== null) return { ...idle, disengage: true, moves: [retreat], attack: { targetId: target.id, option: ranged } };
    }
  }
  // Skirmishers shoot while nobody is on them.
  if (monster.tactic === "skirmisher" && engaged.length === 0 && ranged !== null) {
    const target = pickTarget(encounter, monster, foes.filter((foe) => inRange(encounter, monster, foe, ranged)));
    if (target !== null) return { ...idle, attack: { targetId: target.id, option: ranged } };
  }
  if (engaged.length > 0 && melee !== null) {
    const target = weakest(engaged);
    return { ...idle, attack: { targetId: target.id, option: melee } };
  }
  if (melee !== null) {
    const target = pickTarget(encounter, monster, foes);
    if (target !== null) return approach(encounter, monster, target, melee);
  }
  if (ranged !== null) {
    const target = pickTarget(encounter, monster, foes.filter((foe) => inRange(encounter, monster, foe, ranged)));
    if (target !== null) return { ...idle, attack: { targetId: target.id, option: ranged } };
  }
  return idle;
}

// Cautious autopilot for an away hero (plan §5, Away mode): hit a foe that is
// already engaging the hero, otherwise Dodge. Never moves or spends resources.
export function chooseAutopilotPlan(encounter: EncounterState, hero: Combatant): TurnPlan {
  const melee = hero.attacks.find((attack) => attack.range.kind === "melee");
  const threats = engagedWith(encounter, hero.id).filter((other) => other.side !== hero.side && isActive(other));
  if (melee !== undefined && threats.length > 0) return { ...idle, attack: { targetId: weakest(threats).id, option: melee } };
  return { ...idle, dodge: true };
}

// Walk toward the target and engage it. Attack if it can be reached with
// normal movement; otherwise Dash (spending the action) to close the gap.
function approach(encounter: EncounterState, monster: Combatant, target: Combatant, melee: AttackOption): TurnPlan {
  const path = shortestPath(encounter.edges, monster.zoneId, target.zoneId);
  if (path === null) return idle;
  const needed = path.feet + engageCost;
  if (needed <= monster.speed) {
    return { ...idle, moves: path.zones, engage: target.id, attack: { targetId: target.id, option: melee } };
  }
  const budget = monster.speed * 2;
  const moves: ZoneId[] = [];
  let spent = 0;
  let at = monster.zoneId;
  for (const zone of path.zones) {
    const feet = edgeBetween(encounter.edges, at, zone)?.feet ?? Infinity;
    if (spent + feet > budget) break;
    moves.push(zone);
    spent += feet;
    at = zone;
  }
  const engage = at === target.zoneId && spent + engageCost <= budget ? target.id : null;
  return { ...idle, dash: true, moves, engage };
}

// An adjacent zone within this turn's movement with no conscious foe in it.
function retreatZone(encounter: EncounterState, monster: Combatant): ZoneId | null {
  const occupied = new Set(hostiles(encounter, monster).map((foe) => foe.zoneId));
  const options = encounter.edges
    .flatMap((edge) => (edge.from === monster.zoneId ? [edge] : edge.to === monster.zoneId ? [{ ...edge, to: edge.from }] : []))
    .filter((edge) => edge.feet <= monster.speed && !occupied.has(edge.to))
    .map((edge) => edge.to)
    .sort();
  return options[0] ?? null;
}

function hostiles(encounter: EncounterState, combatant: Combatant): readonly Combatant[] {
  return Object.values(encounter.combatants).filter((other) => other.side !== combatant.side && isActive(other));
}

function inRange(encounter: EncounterState, from: Combatant, to: Combatant, option: AttackOption): boolean {
  const distance = distanceBetween(encounter, from.id, to.id);
  if (distance === null) return false;
  return option.range.kind === "ranged" ? distance <= option.range.long : distance <= 5;
}

// Nearest first, then the most hurt, then by ID so the choice is stable.
function pickTarget(encounter: EncounterState, from: Combatant, candidates: readonly Combatant[]): Combatant | null {
  const ranked = [...candidates].sort((a, b) => {
    const distance = (distanceBetween(encounter, from.id, a.id) ?? Infinity) - (distanceBetween(encounter, from.id, b.id) ?? Infinity);
    return distance !== 0 ? distance : a.hp !== b.hp ? a.hp - b.hp : a.id.localeCompare(b.id);
  });
  return ranked[0] ?? null;
}

function weakest(candidates: readonly Combatant[]): Combatant {
  const [first] = [...candidates].sort((a, b) => (a.hp !== b.hp ? a.hp - b.hp : a.id.localeCompare(b.id)));
  if (first === undefined) throw new Error("weakest() needs at least one candidate.");
  return first;
}
