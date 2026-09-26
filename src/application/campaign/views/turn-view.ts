import type { CharacterId } from "../../../domain/campaign/core/ids.js";
import { isActive, isPresent, currentCombatant, type Combatant, type TurnBudget } from "../../../domain/campaign/combat/combat-state.js";
import { weaponTargets, spellTargets } from "../../../domain/campaign/combat/legal-targets.js";
import { edgeBetween, engageCost, withdrawCost } from "../../../domain/campaign/combat/positioning.js";
import { potionFor } from "../../../domain/campaign/engine/potions.js";
import { formatDiceExpression } from "../../../domain/campaign/dice/dice-expression.js";
import type { SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import { healingPotionCost, type HouseRules } from "../../../domain/campaign/rules/house-rules.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";
import { combatantName, type CombatNames } from "../dm/combat-records.js";

// What a hero can do on their turn, as plain data: only legal choices, each
// with the targets the engine would accept. The private turn menu renders this
// and the engine still checks every command again, so a stale menu is refused
// rather than misapplied (panel spec: Combat targeting).

export interface TargetView {
  readonly id: string;
  readonly name: string;
  readonly zone: string;
  readonly side: "party" | "foes";
  readonly hp: number;
  readonly maxHp: number;
  // Foes show a health band, heroes exact HP.
  readonly band: "unhurt" | "hurt" | "bloodied" | "down";
  readonly self: boolean;
}

export interface AttackChoice {
  readonly weapon: string;
  readonly toHit: number;
  readonly damage: string;
  readonly ranged: boolean;
  readonly targets: readonly TargetView[];
}

export interface SpellChoice {
  readonly spellId: string;
  // 0 for a cantrip; otherwise the slot spent and how many are left.
  readonly slotLevel: number;
  readonly slotsLeft: number;
  readonly bonusAction: boolean;
  readonly maxTargets: number;
  readonly targets: readonly TargetView[];
}

export interface TurnView {
  readonly combatantId: CharacterId;
  readonly heroName: string;
  readonly zone: string;
  readonly budget: TurnBudget;
  readonly engagedWith: readonly string[];
  // An attack or move is being resolved: nothing new can be started yet.
  readonly busy: boolean;
  readonly attacks: readonly AttackChoice[];
  readonly spells: readonly SpellChoice[];
  readonly features: readonly { readonly id: string; readonly bonusAction: boolean; readonly left: number }[];
  readonly potions: readonly { readonly id: string; readonly count: number; readonly bonusAction: boolean }[];
  readonly moves: readonly { readonly zoneId: string; readonly zone: string; readonly feet: number }[];
  // Foes in the hero's zone they are not yet in reach of.
  readonly engage: readonly TargetView[];
  readonly canWithdraw: boolean;
  readonly canDodge: boolean;
  // Anything left worth spending: ending the turn then asks first.
  readonly hasUnspent: boolean;
}

// The hero whose turn it is, or null when it is nobody's turn to plan (a roll
// or attack is being resolved, the hero is down, or it is another creature's).
export function buildTurnView(
  state: CampaignState,
  content: SealedContent,
  houseRules: HouseRules,
  names: CombatNames,
  characterId: CharacterId,
): TurnView | null {
  const encounter = state.encounter;
  if (encounter === null || encounter.status !== "active") return null;
  const hero = encounter.combatants[characterId];
  if (hero === undefined || hero.source.kind !== "hero" || !isActive(hero)) return null;
  if (currentCombatant(encounter)?.id !== hero.id) return null;

  const nameOf = (combatant: Combatant): string => combatantName(combatant, names);
  const zoneOf = (zoneId: string): string => encounter.zones.find((zone) => zone.id === zoneId)?.name ?? zoneId;
  const targetView = (combatant: Combatant): TargetView => ({
    id: combatant.id,
    name: nameOf(combatant),
    zone: zoneOf(combatant.zoneId),
    side: combatant.side,
    hp: combatant.hp,
    maxHp: combatant.maxHp,
    band: bandOf(combatant),
    self: combatant.id === hero.id,
  });
  const sheet = state.characters[characterId];
  const busy = encounter.resolution !== null || encounter.pendingMove !== null;
  const { budget } = hero;

  const attacks: AttackChoice[] = budget.action && !busy
    ? hero.attacks.flatMap((option) => {
        const targets = weaponTargets(encounter, hero, option).map(targetView);
        return targets.length === 0
          ? []
          : [{ weapon: option.weapon, toHit: option.toHit, damage: formatDiceExpression(option.damage), ranged: option.range.kind === "ranged", targets }];
      })
    : [];

  const spells: SpellChoice[] = [];
  for (const id of hero.spellcasting?.spells ?? []) {
    const spell = content.find(id);
    if (spell?.kind !== "spell" || spell.castingTime === "reaction" || busy) continue;
    const bonus = spell.castingTime === "bonus-action";
    if (bonus ? !budget.bonusAction : !budget.action) continue;
    // The lowest slot that fits; a cantrip needs none.
    const slotLevel = spell.level === 0 ? 0 : Object.keys(hero.resources.spellSlots).map(Number).sort((a, b) => a - b).find((level) => level >= spell.level && (hero.resources.spellSlots[level] ?? 0) > 0);
    if (slotLevel === undefined) continue;
    const targets = spellTargets(encounter, hero, spell).map(targetView);
    if (targets.length === 0) continue;
    const extra = spell.level === 0 ? 0 : (spell.targeting.countPerHigherSlot ?? 0) * (slotLevel - spell.level);
    spells.push({
      spellId: spell.id,
      slotLevel,
      slotsLeft: slotLevel === 0 ? 0 : (hero.resources.spellSlots[slotLevel] ?? 0),
      bonusAction: bonus,
      maxTargets: spell.targeting.relation === "self" ? 1 : spell.targeting.count + extra,
      targets,
    });
  }

  const features = hero.features.flatMap((id) => {
    const feature = content.find(id);
    if (feature?.kind !== "feature" || feature.action === null || busy) return [];
    const bonus = feature.action.cost === "bonusAction";
    const left = hero.resources.featureUses[id] ?? 0;
    if (left < 1 || (bonus ? !budget.bonusAction : !budget.action)) return [];
    return [{ id, bonusAction: bonus, left }];
  });

  const potionBonus = houseRules.option(healingPotionCost) === "bonus-action";
  const counts = new Map<string, number>();
  for (const id of sheet?.equipment ?? []) {
    if (potionFor(state, content, characterId, id) !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const potions = busy || (potionBonus ? !budget.bonusAction : !budget.action) ? [] : [...counts].map(([id, count]) => ({ id, count, bonusAction: potionBonus }));

  const engaged = encounter.engagements.some(([a, b]) => a === hero.id || b === hero.id);
  const moves = busy ? [] : encounter.zones.flatMap((zone) => {
    const edge = zone.id === hero.zoneId ? undefined : edgeBetween(encounter.edges, hero.zoneId, zone.id);
    return edge === undefined || edge.feet > budget.movement ? [] : [{ zoneId: zone.id, zone: zone.name, feet: edge.feet }];
  });
  const engage = busy || budget.movement < engageCost
    ? []
    : Object.values(encounter.combatants)
        .filter((other) => other.side !== hero.side && isPresent(other) && other.zoneId === hero.zoneId && !encounter.engagements.some(([a, b]) => (a === hero.id && b === other.id) || (b === hero.id && a === other.id)))
        .map(targetView);
  const engagedWith = encounter.engagements.flatMap(([a, b]) => (a === hero.id ? [b] : b === hero.id ? [a] : []))
    .flatMap((id) => (encounter.combatants[id] === undefined ? [] : [nameOf(encounter.combatants[id])]));
  const canDodge = budget.action && !busy;

  return {
    combatantId: characterId,
    heroName: nameOf(hero),
    zone: zoneOf(hero.zoneId),
    budget,
    engagedWith,
    busy,
    attacks,
    spells,
    features,
    potions,
    moves,
    engage,
    canWithdraw: !busy && engaged && budget.movement >= withdrawCost,
    canDodge,
    hasUnspent: !busy && (budget.action || budget.bonusAction) && (attacks.length + spells.length + features.length + potions.length > 0),
  };
}

function bandOf(combatant: Combatant): TargetView["band"] {
  if (combatant.hp <= 0) return "down";
  if (combatant.hp >= combatant.maxHp) return "unhurt";
  return combatant.hp * 2 > combatant.maxHp ? "hurt" : "bloodied";
}
