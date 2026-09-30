import type { RevivalMagicCommand } from "../commands/campaign-command.js";
import { knownSpells } from "../character/spell-access.js";
import { defaultHeroResources, type HeroStatus } from "../character/hero-status.js";
import type { CharacterId } from "../core/ids.js";
import { mergeSlots, slotUnavailable, spendSlot } from "../magic/spell-rules.js";
import type { SpellDefinition } from "../rules/content-definitions.js";
import type { Effect } from "../rules/effects.js";
import type { ContentId } from "../rules/content-id.js";
import { isFallen } from "../state/campaign-state.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";
import { mayCastOutsideCombat } from "./outside-combat.js";

// Revivify and the spells above it: a hero who fell for good rises again, between fights. The spell's own plan says how (one revive effect
// on one target), so nothing here invents an amount of its own. The spell spends a real slot; the table is told from the saved event.
export function reviveEffectOf(spell: SpellDefinition): Extract<Effect, { kind: "revive" }> | undefined {
  if (spell.level === 0) return undefined;
  const plan = spell.plan({ slotLevel: spell.level, casterLevel: 1, spellcastingModifier: 0 });
  const only = plan.check === null && plan.onAvoid.length === 0 && plan.onLand.length === 1 ? plan.onLand[0] : undefined;
  return only?.kind === "revive" && only.target === "target" ? only : undefined;
}

export function handleRevivalMagicCommand(decision: Decision, command: RevivalMagicCommand): Rejection | null {
  return castReviveSpell(decision, command.characterId, command.targetId, command.spellId, command.slotLevel);
}

function castReviveSpell(decision: Decision, casterId: CharacterId, targetId: CharacterId, spellId: ContentId<"spell">, slotLevel: number): Rejection | null {
  const refusal = mayCastOutsideCombat(decision, casterId);
  if (refusal !== null) return refusal;
  const { state, ctx } = decision;
  const caster = state.characters[casterId];
  const target = state.characters[targetId];
  const spell = ctx.rules.content.find(spellId);
  if (caster === undefined || spell?.kind !== "spell" || !knownSpells(caster, ctx.rules.content).includes(spellId)) return { code: "unknownSpell" };
  const revive = reviveEffectOf(spell);
  if (revive === undefined) return { code: "unknownSpell" };
  if (target === undefined || !isFallen(state, targetId)) return { code: "invalidTarget" };

  const status: HeroStatus = state.heroStatus[casterId] ?? { hp: caster.maxHp, resources: defaultHeroResources(caster, ctx.rules.content) };
  if (slotLevel < spell.level || slotUnavailable(spell, mergeSlots(status.resources.spellSlots, status.resources.pactSlots ?? {}), slotLevel)) return { code: "noSpellSlot", slotLevel };

  const fallen = state.heroStatus[targetId];
  const hp = revive.hp === "full" ? target.maxHp : Math.min(revive.hp, target.maxHp);
  const { dead: _dead, ...rest } = fallen ?? { hp: 0, resources: defaultHeroResources(target, ctx.rules.content) };
  const risen: HeroStatus = { ...rest, hp };
  const spent: HeroStatus = { ...status, resources: spendSlot(status.resources, slotLevel) };
  decision.emit({ kind: "heroRevived", characterId: targetId, heroStatus: targetId === casterId ? { [targetId]: risen } : { [casterId]: spent, [targetId]: risen } });
  return null;
}
