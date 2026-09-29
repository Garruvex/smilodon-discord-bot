import type { CharacterId } from "../../../domain/campaign/core/ids.js";
import { availableSlots, type Combatant, type TurnBudget } from "../../../domain/campaign/combat/combat-state.js";
import { turnOptions } from "../../../domain/campaign/combat/turn-rules.js";
import { spellMaxTargets } from "../../../domain/campaign/magic/spell-rules.js";
import { formatDiceExpression } from "../../../domain/campaign/dice/dice-expression.js";
import type { SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import type { HouseRules } from "../../../domain/campaign/rules/house-rules.js";
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
  // Shields carried, and whether each is on: putting one on or off costs the action.
  readonly shields: readonly { readonly id: string; readonly on: boolean }[];
  readonly moves: readonly { readonly zoneId: string; readonly zone: string; readonly feet: number }[];
  // Foes in the hero's zone they are not yet in reach of.
  readonly engage: readonly TargetView[];
  readonly canWithdraw: boolean;
  readonly canDodge: boolean;
  readonly canDashOrDisengage: boolean;
  // Wild Shape: the beasts a druid may become now, and whether they may return to their own form.
  readonly wildShapes: readonly string[];
  readonly canRevertShape: boolean;
  // Anything left worth spending: ending the turn then asks first.
  readonly hasUnspent: boolean;
}

// The hero whose turn it is, or null when it is nobody's turn to plan (a roll
// or attack is being resolved, the hero is down, or it is another creature's).
// What may be chosen comes from the domain's turnOptions, the same rules the
// engine refuses commands with, so the menu never offers what the engine would
// turn down; this only adds names and display text.
export function buildTurnView(
  state: CampaignState,
  content: SealedContent,
  houseRules: HouseRules,
  names: CombatNames,
  characterId: CharacterId,
): TurnView | null {
  const options = turnOptions(state.encounter, state.characters[characterId], content, houseRules, characterId);
  const encounter = state.encounter;
  const hero = encounter?.combatants[characterId];
  if (options === null || encounter === null || hero === undefined) return null;

  const nameOf = (combatant: Combatant): string => combatantName(combatant, names);
  const zoneOf = (zoneId: string): string => encounter.zones.find((zone) => zone.id === zoneId)?.name ?? zoneId;
  const targetView = (id: string): TargetView[] => {
    const combatant = encounter.combatants[id];
    return combatant === undefined
      ? []
      : [{ id: combatant.id, name: nameOf(combatant), zone: zoneOf(combatant.zoneId), side: combatant.side, hp: combatant.hp, maxHp: combatant.maxHp, band: bandOf(combatant), self: combatant.id === hero.id }];
  };

  const attacks: AttackChoice[] = options.attacks.map(({ option, targetIds }) => ({
    weapon: option.weapon,
    toHit: option.toHit,
    damage: formatDiceExpression(option.damage),
    ranged: option.range.kind === "ranged",
    targets: targetIds.flatMap(targetView),
  }));

  // One choice per slot level the spell could be upcast to, not just the
  // lowest that fits (plan §8: "all available slot levels"), so a healing or
  // damage spell can be cast at a higher level for more effect when a hero
  // has slots to spare, not only ever at the cheapest one that works.
  // The merged count (ordinary slots plus Pact Magic), not spellSlots alone:
  // a Warlock's Pact slots cast this spell exactly as well as an ordinary
  // one does, so "how many casts are left at this level" means both pools
  // together, the same total availableSlots() already used to decide which
  // levels are offered at all.
  const slots = availableSlots(hero.resources);
  const spells: SpellChoice[] = options.spells.flatMap(({ spell, slotLevels, bonusAction, targetIds }) =>
    slotLevels.map((slotLevel) => ({
      spellId: spell.id,
      slotLevel,
      slotsLeft: slotLevel === 0 ? 0 : (slots[slotLevel] ?? 0),
      bonusAction,
      maxTargets: spellMaxTargets(spell, slotLevel),
      targets: targetIds.flatMap(targetView),
    })),
  );

  const engagedWith = encounter.engagements
    .flatMap(([a, b]) => (a === hero.id ? [b] : b === hero.id ? [a] : []))
    .flatMap((id) => (encounter.combatants[id] === undefined ? [] : [nameOf(encounter.combatants[id])]));

  return {
    combatantId: characterId,
    heroName: nameOf(hero),
    zone: zoneOf(hero.zoneId),
    budget: hero.budget,
    engagedWith,
    busy: options.busy,
    attacks,
    spells,
    features: options.features.map(({ feature, bonusAction, left }) => ({ id: feature.id, bonusAction, left })),
    potions: options.potions.map(({ itemId, count, bonusAction }) => ({ id: itemId, count, bonusAction })),
    shields: options.shields.filter((shield) => shield.canSwitch).map(({ itemId, on }) => ({ id: itemId, on })),
    moves: options.moves.map(({ zoneId, feet }) => ({ zoneId, zone: zoneOf(zoneId), feet })),
    engage: options.engage.flatMap(targetView),
    canWithdraw: options.canWithdraw,
    canDodge: options.canTakeAction,
    canDashOrDisengage: options.canDashOrDisengage,
    wildShapes: options.wildShapeForms,
    canRevertShape: options.canRevertShape,
    hasUnspent: options.hasUnspent,
  };
}

function bandOf(combatant: Combatant): TargetView["band"] {
  if (combatant.hp <= 0) return "down";
  if (combatant.hp >= combatant.maxHp) return "unhurt";
  return combatant.hp * 2 > combatant.maxHp ? "hurt" : "bloodied";
}
