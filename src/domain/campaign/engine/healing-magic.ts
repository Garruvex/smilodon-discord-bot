import type { HealingMagicCommand } from "../commands/campaign-command.js";
import { abilityModifier } from "../character/character-sheet.js";
import { spellbookOf } from "../character/spell-access.js";
import { defaultHeroResources, type HeroStatus } from "../character/hero-status.js";
import type { CharacterId } from "../core/ids.js";
import { plus } from "../dice/dice-expression.js";
import { resultMatchesSpec, type RollResult, type RollSpec } from "../dice/roll-spec.js";
import { mergeSlots, slotUnavailable, spendSlot } from "../magic/spell-rules.js";
import { traitsOf, type SpellDefinition } from "../rules/content-definitions.js";
import type { Effect } from "../rules/effects.js";
import type { ContentId } from "../rules/content-id.js";
import { isFallen, type HealingRecord, type PendingHealing } from "../state/campaign-state.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";
import { mayCastOutsideCombat } from "./utility-magic.js";

// A slotted healing spell (Cure Wounds, Healing Word) cast on a friend outside
// a fight: it spends a real slot and a real roll decides how much it heals.
// Nothing is narrated by the model: the amount is a fact, so the table is told
// it from the saved event. The spell's own plan (content-definitions.ts) says
// how much it heals, so this never invents a healing number of its own; a spell
// whose plan is anything but one healing effect on one target is refused, since
// a fight is where the rest of magic belongs.
// The healing a spell does when cast on a friend at this slot level, or undefined
// when it is anything but one healing effect on one target (so a view can offer
// exactly the spells the engine will accept).
export function healingEffectOf(spell: SpellDefinition, slotLevel: number, casterLevel: number, modifier: number): Extract<Effect, { kind: "heal" }> | undefined {
  if (spell.level === 0) return undefined;
  const plan = spell.plan({ slotLevel, casterLevel, spellcastingModifier: modifier });
  const only = plan.check === null && plan.onAvoid.length === 0 && plan.onLand.length === 1 ? plan.onLand[0] : undefined;
  return only?.kind === "heal" && only.target === "target" ? only : undefined;
}

export function handleHealingMagicCommand(decision: Decision, command: HealingMagicCommand): Rejection | null {
  return castHealingSpell(decision, command.characterId, command.targetId, command.spellId, command.slotLevel);
}

function castHealingSpell(decision: Decision, casterId: CharacterId, targetId: CharacterId, spellId: ContentId<"spell">, slotLevel: number): Rejection | null {
  const refusal = mayCastOutsideCombat(decision, casterId);
  if (refusal !== null) return refusal;
  const { state, ctx } = decision;
  const caster = state.characters[casterId];
  const target = state.characters[targetId];
  const spell = ctx.rules.content.find(spellId);
  if (caster === undefined || spell?.kind !== "spell" || caster.spellcasting === null || !spellbookOf(caster, ctx.rules.content).includes(spellId)) return { code: "unknownSpell" };
  if (target === undefined || isFallen(state, targetId)) return { code: "invalidTarget" };
  if (state.healingPending?.[casterId] !== undefined) return { code: "healingAlreadyPending" };

  const heal = healingEffectOf(spell, slotLevel, caster.level, abilityModifier(caster.abilityScores[caster.spellcasting.ability]));
  if (heal === undefined) return { code: "notAHealingSpell" };

  const status = state.heroStatus[casterId] ?? { hp: caster.maxHp, resources: defaultHeroResources(caster, ctx.rules.content) };
  if (slotUnavailable(spell, mergeSlots(status.resources.spellSlots, status.resources.pactSlots ?? {}), slotLevel)) return { code: "noSpellSlot", slotLevel };
  if ((state.heroStatus[targetId]?.hp ?? target.maxHp) >= target.maxHp) return { code: "nothingToHeal" };

  // Disciple of Life and similar: extra healing from a leveled spell.
  const bonus = caster.features.reduce((sum, id) => {
    const definition = ctx.rules.content.find(id);
    const traits = definition === undefined ? [] : traitsOf(definition);
    return sum + traits.reduce((inner, trait) => inner + (trait.kind === "healingBonus" ? trait.flat + trait.perSpellLevel * slotLevel : 0), 0);
  }, 0);
  const healing: PendingHealing = {
    casterId,
    targetId,
    spellId,
    slotLevel,
    expression: bonus === 0 ? heal.amount : plus(heal.amount, bonus),
    rollId: `heal-roll:${casterId}:${state.healingCount + 1}`,
  };
  const spec: RollSpec = { kind: "dice", expression: healing.expression, critical: false };
  decision.emit({ kind: "healingStarted", healing });
  decision.request({ kind: "roll", rollId: healing.rollId, spec });
  return null;
}

// The roll worker saved the healing dice: the slot is spent and the hit points
// restored (up to the target's maximum) in the one settling event.
export function recordHealingRoll(decision: Decision, healing: PendingHealing, result: RollResult): Rejection | null {
  if (!resultMatchesSpec(result, { kind: "dice", expression: healing.expression, critical: false }) || result.kind !== "dice") return { code: "rollMismatch" };
  const { state, ctx } = decision;
  const caster = state.characters[healing.casterId];
  const target = state.characters[healing.targetId];
  if (caster === undefined || target === undefined) return { code: "staleNarration" };

  const fresh = (id: CharacterId): HeroStatus => {
    const sheet = state.characters[id];
    return state.heroStatus[id] ?? { hp: sheet?.maxHp ?? 0, resources: sheet === undefined ? { spellSlots: {}, featureUses: {} } : defaultHeroResources(sheet, ctx.rules.content) };
  };
  const spent: HeroStatus = { ...fresh(healing.casterId), resources: spendSlot(fresh(healing.casterId).resources, healing.slotLevel) };
  const before = healing.targetId === healing.casterId ? spent : fresh(healing.targetId);
  const hpAfter = Math.min(target.maxHp, before.hp + result.roll.total);
  const healed = hpAfter - before.hp;
  const record: HealingRecord = {
    id: `healing:${state.healingCount + 1}`,
    casterId: healing.casterId,
    targetId: healing.targetId,
    spellId: healing.spellId,
    slotLevel: healing.slotLevel,
    expression: healing.expression,
    rolled: result.roll.total,
    healed,
    hpAfter,
  };
  const targetStatus: HeroStatus = { ...before, hp: hpAfter };
  const heroStatus: Readonly<Record<CharacterId, HeroStatus>> = healing.targetId === healing.casterId ? { [healing.casterId]: targetStatus } : { [healing.casterId]: spent, [healing.targetId]: targetStatus };
  decision.emit({ kind: "healingSettled", healing: record, heroStatus });
  decision.request({ kind: "deliver", delivery: { kind: "healingSettled", healingId: record.id } });
  return null;
}
