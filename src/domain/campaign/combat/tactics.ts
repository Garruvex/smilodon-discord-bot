import { maximumOf } from "../dice/dice-expression.js";
import type { SpellDefinition } from "../rules/content-definitions.js";
import type { ContentId } from "../rules/content-id.js";
import type { SealedContent } from "../rules/content-registry.js";
import type { AreaAttack } from "../rules/traits.js";
import { castableSlotLevels, innateUseKey, spellMaxTargets } from "../magic/spell-rules.js";
import type { AttackOption, Combatant, CombatantId, EncounterState, ZoneId } from "./combat-state.js";
import { availableSlots, engagedWith, isActive } from "./combat-state.js";
import { spellTargets } from "./legal-targets.js";
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
  // A breath weapon in place of an attack.
  readonly area: { readonly area: AreaAttack; readonly targetIds: readonly CombatantId[] } | null;
  // A spell in place of an attack.
  readonly cast: SpellCast | null;
  readonly dodge: boolean;
}

export interface SpellCast {
  readonly spellId: ContentId<"spell">;
  readonly slotLevel: number;
  readonly targetIds: readonly CombatantId[];
}

const idle: TurnPlan = { disengage: false, dash: false, moves: [], engage: null, attack: null, area: null, cast: null, dodge: false };

// Monsters leave downed heroes alone by default (plan §6: focus-firing
// unconscious heroes is off unless a house rule enables it).
export function chooseMonsterPlan(encounter: EncounterState, monster: Combatant, content?: SealedContent): TurnPlan {
  const foes = hostiles(encounter, monster);
  if (foes.length === 0) return idle;
  // A spell that hurts or hinders foes, when the monster has one it can cast, is cast before anything else.
  const cast = content === undefined ? null : chooseSpell(encounter, monster, content);
  if (cast !== null) return { ...idle, cast };
  // A breath weapon that is ready and catches anyone is used before anything else.
  // An aura that costs no action goes first.
  const ordered = [...monster.traits].sort((a, b) => Number(b.kind === "areaAttack" && b.free === true) - Number(a.kind === "areaAttack" && a.free === true));
  for (const trait of ordered) {
    if (trait.kind !== "areaAttack" || (monster.cooldowns[trait.weapon] ?? 0) > 0) continue;
    const caught = foes.filter((foe) => (distanceBetween(encounter, monster.id, foe.id) ?? Infinity) <= trait.range);
    if (caught.length > 0) return { ...idle, area: { area: trait, targetIds: caught.map((foe) => foe.id) } };
  }
  // A Multiattack opens with its first weapon.
  const opener = monster.traits.find((trait) => trait.kind === "multiattack")?.weapons[0];
  const melee = monster.attacks.find((attack) => attack.range.kind === "melee" && attack.weapon === opener) ?? monster.attacks.find((attack) => attack.range.kind === "melee") ?? null;
  const ranged = monster.attacks.find((attack) => attack.range.kind === "ranged") ?? null;
  const engaged = engagedWith(encounter, monster.id).filter((other) => other.side !== monster.side && isActive(other));

  // Skirmishers retreat from melee to shoot. Nimble Escape makes the retreat
  // free (Disengage as a bonus action); without it, the retreat still goes
  // ahead and risks whatever opportunity attack it draws (movement.ts: an
  // engine-played foe always takes it, a player-controlled one is offered
  // the choice) — a monster with a bow is still better off shooting than
  // trading blows in melee.
  if (monster.tactic === "skirmisher" && engaged.length > 0 && ranged !== null) {
    const retreat = retreatZone(encounter, monster);
    if (retreat !== null) {
      const moved = { ...encounter, combatants: { ...encounter.combatants, [monster.id]: { ...monster, zoneId: retreat } }, engagements: [] };
      const target = pickTarget(moved, { ...monster, zoneId: retreat }, foes.filter((foe) => inRange(moved, { ...monster, zoneId: retreat }, foe, ranged)));
      if (target !== null) {
        const nimble = monster.traits.some((trait) => trait.kind === "nimbleEscape");
        return { ...idle, disengage: nimble, moves: [retreat], attack: { targetId: target.id, option: ranged } };
      }
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

// The best spell a monster can cast at foes now: a leveled one over a cantrip, and the one that
// catches the most creatures among those. Never one that would end a concentration it is holding.
function chooseSpell(encounter: EncounterState, monster: Combatant, content: SealedContent): SpellCast | null {
  const casting = monster.spellcasting;
  if (casting === null) return null;
  let best: { readonly cast: SpellCast; readonly score: number } | null = null;
  // A cantrip is worth casting over a weapon only for a monster that shoots from range or has no weapon to swing.
  const cantrips = monster.tactic === "skirmisher" || monster.attacks.every((attack) => maximumOf(attack.damage) <= 0);
  for (const id of casting.spells) {
    const spell = content.find(id);
    if (spell?.kind !== "spell" || spell.castingTime !== "action" || (spell.concentration && monster.concentration !== null)) continue;
    if (spell.level === 0 && !cantrips) continue;
    const innate = casting.innate?.[id];
    let slotLevel: number;
    if (innate !== undefined) {
      if (innate !== null && (monster.resources.featureUses[innateUseKey(id)] ?? innate) < 1) continue;
      slotLevel = spell.level;
    } else {
      const levels = castableSlotLevels(spell, availableSlots(monster.resources));
      const lowest = levels[0];
      if (lowest === undefined) continue;
      slotLevel = lowest;
    }
    if (!hurtsFoes(spell, slotLevel, monster)) continue;
    const reachable = [...spellTargets(encounter, monster, spell, content)].sort((a, b) => (a.hp !== b.hp ? a.hp - b.hp : a.id.localeCompare(b.id)));
    const targets = reachable.slice(0, spellMaxTargets(spell, slotLevel));
    if (targets.length === 0) continue;
    const score = spell.level * 10 + targets.length;
    if (best === null || score > best.score) best = { cast: { spellId: id, slotLevel, targetIds: targets.map((target) => target.id) }, score };
  }
  return best?.cast ?? null;
}

// Whether the spell does harm to whoever it is aimed at: damage, or a condition or modifier laid on them.
function hurtsFoes(spell: SpellDefinition, slotLevel: number, monster: Combatant): boolean {
  if (spell.targeting.relation !== "enemy") return false;
  const plan = spell.plan({ slotLevel, casterLevel: monster.spellcasting?.casterLevel ?? 1, spellcastingModifier: monster.spellcasting?.modifier ?? 0 });
  return plan.onLand.some((effect) => effect.kind === "damage" || effect.kind === "applyCondition" || effect.kind === "applyModifiers");
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
