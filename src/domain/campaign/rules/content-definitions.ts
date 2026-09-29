import { assertNever } from "../core/assert-never.js";
import type { DiceExpression } from "../dice/dice-expression.js";
import type { Capability } from "./capabilities.js";
import type { ContentId, ContentKind } from "./content-id.js";
import type { Ability, DamageType, Effect, ResolutionPlan } from "./effects.js";
import type { Modifier } from "./modifiers.js";
import type { Skill } from "./skills.js";
import type { Trait } from "./traits.js";

// Content definitions. Each kind keeps the data that is genuinely its own
// (a spell's slot level, a weapon's range, armor's AC formula), but they all
// feed two shared engine systems:
//   - Actions resolve through one ResolutionPlan (check, then effects):
//     weapon attacks, spells, monster attacks, and feature actions alike.
//   - Passive rules are Traits, granted by armor, features, and monsters.
// A new spell, item, or monster is data; engine code changes only for a new
// effect or trait kind, which every source then shares.

interface DefinitionBase<K extends ContentKind> {
  readonly id: ContentId<K>;
  readonly kind: K;
  // Where the rules text comes from, e.g. "SRD 5.1". Required for attribution.
  readonly source: string;
  // Capabilities beyond those derived from the definition's shape.
  readonly extraRequires?: readonly Capability[];
}

export interface ConditionDefinition extends DefinitionBase<"condition"> {
  // Conditions this one always includes, e.g. Unconscious includes
  // Incapacitated and Prone.
  readonly includes: readonly ContentId<"condition">[];
  // What the condition does, from the modifier vocabulary. The rule queries
  // read these; no rule looks for a condition by name.
  readonly modifiers: readonly Modifier[];
}

export type CastingTime = "action" | "bonus-action" | "reaction";

export type SpellRange =
  | { readonly kind: "self" }
  | { readonly kind: "touch" }
  | { readonly kind: "feet"; readonly feet: number };

export interface SpellTargeting {
  readonly relation: "self" | "ally-or-self" | "creature" | "enemy";
  readonly count: number;
  // Extra targets per slot level above the spell's level (Bless: 1).
  readonly countPerHigherSlot?: number;
}

export interface SpellCastContext {
  // 0 for cantrips; otherwise the slot spent, >= the spell's level.
  readonly slotLevel: number;
  readonly casterLevel: number;
  readonly spellcastingModifier: number;
}

// What a reaction spell does when cast in response to being hit. A closed set:
// each kind is a mechanic the engine implements (engine/combat/reactions.ts).
export type ReactionRule = { readonly kind: "acBonusUntilNextTurn"; readonly bonus: number };

export interface SpellDefinition extends DefinitionBase<"spell"> {
  readonly level: number; // 0 = cantrip
  readonly castingTime: CastingTime;
  // Set on spells cast as a reaction to being hit (Shield); they are never cast on the caster's turn.
  readonly reaction?: ReactionRule;
  readonly range: SpellRange;
  readonly targeting: SpellTargeting;
  readonly concentration: boolean;
  // SRD ritual tag: a hero who knows the spell may cast it without spending
  // a slot (engine/utility-magic.ts's castRitualSpell), the extra ten
  // minutes narrated rather than timed. A simplification of the SRD's own
  // rule, which also requires a class's separate Ritual Casting feature —
  // not modeled here; knowing the spell is enough.
  readonly ritual?: boolean;
  plan(context: SpellCastContext): ResolutionPlan;
}

// Melee weapons reach 5 feet (no reach weapons in the milestone 0 catalog);
// ranged weapons have a normal and a long range in feet.
export type WeaponRange = { readonly kind: "melee" } | { readonly kind: "ranged"; readonly normal: number; readonly long: number };

export interface WeaponDefinition extends DefinitionBase<"item"> {
  readonly itemType: "weapon";
  readonly damage: DiceExpression;
  readonly damageType: DamageType;
  readonly range: WeaponRange;
  // Finesse: the wielder may use Dexterity instead of Strength.
  readonly finesse: boolean;
  // Natural weapons (bite, claws) belong to monsters and are never carried.
  readonly natural: boolean;
}

export interface ArmorDefinition extends DefinitionBase<"item"> {
  readonly itemType: "armor";
  readonly category: "light" | "medium" | "heavy";
  readonly baseArmorClass: number;
  // null: add the full Dexterity modifier; 2: medium armor; 0: heavy armor.
  readonly dexterityCap: number | null;
  readonly stealthDisadvantage: boolean;
  readonly strengthRequirement: number | null;
}

export interface ShieldDefinition extends DefinitionBase<"item"> {
  readonly itemType: "shield";
  readonly armorClassBonus: number;
}

// Drunk by the hero holding it. Healing is the average of the potion's dice
// (2d4+2 is 7), so using one needs no roll, as with Hit Dice on a rest.
export interface PotionDefinition extends DefinitionBase<"item"> {
  readonly itemType: "potion";
  readonly healing: number;
}

export type ItemDefinition = WeaponDefinition | ArmorDefinition | ShieldDefinition | PotionDefinition;

// A limited-use action a feature grants, resolved like any other action.
export interface FeatureAction {
  readonly cost: "action" | "bonusAction";
  readonly uses: { readonly count: number; readonly recharge: "shortRest" | "longRest" };
  // Feature actions in milestone 0 target the user (Second Wind).
  plan(context: { readonly level: number }): ResolutionPlan;
}

export interface FeatureDefinition extends DefinitionBase<"feature"> {
  readonly traits: readonly Trait[];
  readonly action: FeatureAction | null;
}

// How an ordinary monster fights without a model call (plan §6, NPCs and
// monsters in combat). brute: close in and hit the nearest hero.
// skirmisher: shoot from range when not engaged, otherwise fight in melee.
export type MonsterTactic = "brute" | "skirmisher";

// A stat-block attack: to-hit and damage are fixed by the stat block and
// already include the monster's modifiers.
export interface MonsterAttack {
  readonly weapon: ContentId<"item">;
  readonly toHit: number;
  readonly damage: DiceExpression;
  // Overrides the weapon's range, e.g. a javelin thrown at 30/120 feet.
  readonly range?: WeaponRange;
  // Extra effects on a hit, such as a wolf's bite knocking the target prone.
  readonly onHit?: readonly Effect[];
}

export interface MonsterDefinition extends DefinitionBase<"monster"> {
  readonly armorClass: number;
  // The stat block's average hit points.
  readonly maxHp: number;
  // SRD 5.1's XP by challenge rating, split evenly among the party (character/leveling.ts).
  readonly xp: number;
  readonly speed: number;
  readonly abilityScores: Readonly<Record<Ability, number>>;
  readonly attacks: readonly MonsterAttack[];
  readonly tactic: MonsterTactic;
  readonly traits: readonly Trait[];
  // Set on beasts only: what a Druid's Wild Shape checks (rules/wild-shape-rules.ts).
  readonly beast?: { readonly challengeRating: number; readonly flies: boolean; readonly swims: boolean };
}

// How a class casts, if at all: full (Wizard-shaped slot table), half
// (Paladin/Ranger), pact (Warlock's own table), or none. Read alongside
// spellcastingAbility by leveling.ts's spellSlotsForLevel.
export type CasterType = "full" | "half" | "pact" | "none";

// One of a class's starting kits: the player's gear choice at level 1.
export interface StartingKit {
  readonly id: string;
  readonly equipment: readonly ContentId<"item">[];
}

export interface ClassDefinition extends DefinitionBase<"class"> {
  readonly hitDie: 6 | 8 | 10 | 12;
  readonly savingThrows: readonly Ability[];
  // The skills the class may choose from, how many, and how many get expertise.
  readonly skillChoices: readonly Skill[];
  readonly skillCount: number;
  readonly expertiseCount: number;
  // Features granted at level 1. Levels 2+ are levelFeatures below.
  readonly features: readonly ContentId<"feature">[];
  readonly kits: readonly StartingKit[];
  // What a level-1 hero of this class casts, if anything (paladin and
  // ranger have none until level 2, so this is null for them).
  readonly spellcasting: { readonly ability: Ability; readonly spells: readonly ContentId<"spell">[]; readonly slots: Readonly<Record<number, number>> } | null;
  // The abilities worth the highest scores, as a suggestion for the builder's default.
  readonly suggested: readonly Ability[];
  readonly casterType: CasterType;
  // The ability every spell this class knows keys off, independent of
  // whether it has any spells yet at level 1 (paladin/ranger: cha/wis).
  readonly spellcastingAbility: Ability | null;
  // Seeded the moment a half- or pact caster's spellcasting first appears
  // past level 1 (paladin, ranger); empty for classes whose level-1 template
  // already carries spells, or that never cast at all.
  readonly firstSpells: readonly ContentId<"spell">[];
  // Narrative or mechanical features granted at levels 2+, by level. Level 1's
  // own features are the `features` field above, not this one.
  readonly levelFeatures: Readonly<Record<number, readonly ContentId<"feature">[]>>;
  // SRD 5.1 multiclassing: every group here needs at least one ability at
  // 13+ in the hero's scores before they may take their first level in this
  // class (groups AND together; abilities within a group are an OR — e.g.
  // Fighter's Strength-or-Dexterity). A class the hero already holds levels
  // in is exempt (character-build.ts's canMulticlassInto); SRD's matching
  // requirement to also keep 13+ in one's existing class(es) is not checked,
  // the same "gate the choice, not the whole sheet" liberty.
  readonly multiclassRequires: readonly (readonly Ability[])[];
  // The one skill a hero may pick when adding this class as other than their
  // first (SRD 5.1's Multiclassing Proficiencies table); absent for classes
  // that grant none there. That table's armor and weapon proficiencies are
  // not modeled: this engine has no proficiency-gated AC or attack roll at
  // all (heroes are always proficient with what they carry —
  // combatant-profile.ts), so granting them here would be inert.
  readonly multiclassSkillChoices?: readonly Skill[];
}

export interface RaceDefinition extends DefinitionBase<"race"> {
  readonly speed: number;
  // Only the abilities this race raises; SRD 5.1's fixed racial bonus (e.g.
  // Elf +2 Dex, Human +1 to all six).
  readonly abilityScoreIncrease: Readonly<Partial<Record<Ability, number>>>;
  // From the shared Trait vocabulary, same as armor, features, and monsters
  // (e.g. Dwarven Resilience's poison resistance). Traits the engine does
  // not implement yet (Darkvision — no vision system; save-advantage against
  // a specific condition; a bonus cantrip outside the class list) are left
  // out and documented per race (content/srd-5.1/races.ts), the same
  // "not modeled" convention the monster roster already uses.
  readonly traits: readonly Trait[];
}

export type ContentDefinition = ConditionDefinition | SpellDefinition | ItemDefinition | FeatureDefinition | MonsterDefinition | ClassDefinition | RaceDefinition;

export type DefinitionOf<K extends ContentKind> = Extract<ContentDefinition, { kind: K }>;

export function defineCondition(definition: Omit<ConditionDefinition, "kind">): ConditionDefinition {
  return { ...definition, kind: "condition" };
}

export function defineSpell(definition: Omit<SpellDefinition, "kind">): SpellDefinition {
  return { ...definition, kind: "spell" };
}

export function defineWeapon(definition: Omit<WeaponDefinition, "kind" | "itemType">): WeaponDefinition {
  return { ...definition, kind: "item", itemType: "weapon" };
}

export function defineArmor(definition: Omit<ArmorDefinition, "kind" | "itemType">): ArmorDefinition {
  return { ...definition, kind: "item", itemType: "armor" };
}

export function defineShield(definition: Omit<ShieldDefinition, "kind" | "itemType">): ShieldDefinition {
  return { ...definition, kind: "item", itemType: "shield" };
}

export function definePotion(definition: Omit<PotionDefinition, "kind" | "itemType">): PotionDefinition {
  return { ...definition, kind: "item", itemType: "potion" };
}

export function defineFeature(definition: Omit<FeatureDefinition, "kind">): FeatureDefinition {
  return { ...definition, kind: "feature" };
}

export function defineMonster(definition: Omit<MonsterDefinition, "kind">): MonsterDefinition {
  return { ...definition, kind: "monster" };
}

export function defineClass(definition: Omit<ClassDefinition, "kind">): ClassDefinition {
  return { ...definition, kind: "class" };
}

export function defineRace(definition: Omit<RaceDefinition, "kind">): RaceDefinition {
  return { ...definition, kind: "race" };
}

// The passive traits a definition grants its owner.
export function traitsOf(definition: ContentDefinition): readonly Trait[] {
  switch (definition.kind) {
    case "item":
      switch (definition.itemType) {
        case "armor":
          return [{ kind: "armor", baseArmorClass: definition.baseArmorClass, dexterityCap: definition.dexterityCap }];
        case "shield":
          return [{ kind: "armorClassBonus", amount: definition.armorClassBonus }];
        case "weapon":
        case "potion":
          return [];
        default:
          return assertNever(definition);
      }
    case "feature":
    case "monster":
      return definition.traits;
    case "race":
      return definition.traits;
    case "condition":
    case "spell":
    case "class":
      return [];
    default:
      return assertNever(definition);
  }
}

export const maxSpellLevel = 9;

// Every slot level a spell can be cast at: [0] for cantrips, level..9 otherwise.
export function castableSlotLevels(spell: SpellDefinition): readonly number[] {
  if (spell.level === 0) return [0];
  return Array.from({ length: maxSpellLevel - spell.level + 1 }, (_, index) => spell.level + index);
}

// Plans evaluated for validation: every castable slot level, at a caster
// level that can cast it. Throws propagate to the registry as problems.
export function samplePlans(spell: SpellDefinition): readonly ResolutionPlan[] {
  return castableSlotLevels(spell).map((slotLevel) =>
    spell.plan({ slotLevel, casterLevel: Math.max(1, slotLevel * 2 - 1), spellcastingModifier: 3 }),
  );
}

// Every plan a definition can produce, for capability and reference checks.
function plansOf(definition: ContentDefinition): readonly ResolutionPlan[] {
  switch (definition.kind) {
    case "spell":
      return samplePlans(definition);
    case "feature":
      return definition.action === null ? [] : [definition.action.plan({ level: 1 }), definition.action.plan({ level: 20 })];
    case "monster":
      return definition.attacks.map((attack) => ({ check: { kind: "weaponAttack" }, onLand: attack.onHit ?? [], onAvoid: [] }));
    case "item":
    case "condition":
    case "class":
    case "race":
      return [];
    default:
      return assertNever(definition);
  }
}

export function requiredCapabilities(definition: ContentDefinition): ReadonlySet<Capability> {
  const required = new Set<Capability>(definition.extraRequires ?? []);
  switch (definition.kind) {
    case "condition":
      required.add("conditions");
      break;
    case "spell":
      if (definition.level > 0) required.add("spell-slots");
      if (definition.concentration) required.add("concentration");
      if (definition.reaction !== undefined) required.add("reactions");
      break;
    case "item":
      if (definition.itemType === "weapon") {
        required.add("attack-rolls");
        required.add("damage");
      }
      break;
    case "monster":
      required.add("attack-rolls");
      required.add("damage");
      break;
    case "feature":
    case "class":
    case "race":
      break;
    default:
      assertNever(definition);
  }
  for (const plan of plansOf(definition)) {
    if (plan.check?.kind === "spellAttack" || plan.check?.kind === "weaponAttack") required.add("attack-rolls");
    if (plan.check?.kind === "savingThrow") required.add("saving-throws");
    for (const effect of [...plan.onLand, ...plan.onAvoid]) for (const capability of capabilitiesFor(effect)) required.add(capability);
  }
  return required;
}

export function referencedContent(definition: ContentDefinition): readonly ContentId[] {
  const fromPlans = plansOf(definition).flatMap((plan) =>
    [...plan.onLand, ...plan.onAvoid].flatMap((effect) =>
      effect.kind === "applyCondition" || effect.kind === "conditionUnlessSave" ? [effect.condition] : [],
    ),
  );
  switch (definition.kind) {
    case "condition":
      return definition.includes;
    case "monster":
      return [...definition.attacks.map((attack) => attack.weapon), ...fromPlans];
    case "class":
      return [
        ...definition.kits.flatMap((kit) => kit.equipment),
        ...definition.features,
        ...Object.values(definition.levelFeatures).flat(),
        ...(definition.spellcasting?.spells ?? []),
        ...definition.firstSpells,
      ];
    case "spell":
    case "item":
    case "feature":
    case "race":
      return fromPlans;
    default:
      return assertNever(definition);
  }
}

function capabilitiesFor(effect: Effect): readonly Capability[] {
  switch (effect.kind) {
    case "damage":
      return ["damage"];
    case "heal":
      return ["healing"];
    case "applyCondition":
      return ["conditions"];
    case "bonusDie":
      return ["bonus-dice"];
    case "nextAttackAdvantage":
      return ["attack-rolls"];
    case "conditionUnlessSave":
      return ["saving-throws", "conditions"];
    case "exhaustion":
      return ["exhaustion"];
    default:
      return assertNever(effect);
  }
}
