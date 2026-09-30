import type { CompanionMagicCommand } from "../commands/campaign-command.js";
import { companionsOf, type Companion } from "../companions/companion-roster.js";
import { knownSpells } from "../character/spell-access.js";
import { defaultHeroResources } from "../character/hero-status.js";
import type { CharacterId } from "../core/ids.js";
import { mergeSlots, slotUnavailable, spendSlot } from "../magic/spell-rules.js";
import type { SpellDefinition } from "../rules/content-definitions.js";
import type { Effect } from "../rules/effects.js";
import type { ContentId } from "../rules/content-id.js";
import type { UtilityCastRecord } from "../state/campaign-state.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";
import { mayCastOutsideCombat } from "./outside-combat.js";

// A familiar or a minute-long conjuring, cast between fights. A spell qualifies when it takes a minute or more
// (so it is never cast in a fight) and its plan is one summon on the caster, so this never invents a creature
// of its own: the spell's plan names it, and the content register supplies the stat block when the fight begins.
// The creatures are kept by the campaign (companions/companion-roster.ts) and join the next fight on the party's
// side; the Narrator describes the casting the way it does a ritual.
export function companionEffectOf(spell: SpellDefinition): Extract<Effect, { kind: "summon" }> | undefined {
  if (spell.castingTime !== "long") return undefined;
  const plan = spell.plan({ slotLevel: spell.level, casterLevel: 1, spellcastingModifier: 0 });
  const only = plan.check === null && plan.onAvoid.length === 0 && plan.onLand.length === 1 ? plan.onLand[0] : undefined;
  return only?.kind === "summon" && only.target === "self" ? only : undefined;
}

export function handleCompanionMagicCommand(decision: Decision, command: CompanionMagicCommand): Rejection | null {
  switch (command.kind) {
    case "summonCompanion":
      return summonCompanion(decision, command.characterId, command.spellId, command.slotLevel);
    case "dismissCompanion":
      return dismissCompanion(decision, command.characterId, command.companionId);
  }
}

// A ritual that calls a creature (Find Familiar) is cast from the same menu as any ritual: when it is one,
// this takes the casting over and says so by returning a result (null for accepted); undefined means it is not one.
export function summonCompanionRitual(decision: Decision, casterId: CharacterId, spellId: ContentId<"spell">): Rejection | null | undefined {
  const spell = decision.ctx.rules.content.find(spellId);
  if (spell?.kind !== "spell" || spell.ritual !== true || companionEffectOf(spell) === undefined) return undefined;
  return summonCompanion(decision, casterId, spellId, spell.level);
}

function summonCompanion(decision: Decision, casterId: CharacterId, spellId: ContentId<"spell">, slotLevel: number): Rejection | null {
  const refusal = mayCastOutsideCombat(decision, casterId);
  if (refusal !== null) return refusal;
  const { state, ctx } = decision;
  const caster = state.characters[casterId];
  const spell = ctx.rules.content.find(spellId);
  if (caster === undefined || spell?.kind !== "spell" || !knownSpells(caster, ctx.rules.content).includes(spellId)) return { code: "unknownSpell" };
  const summon = companionEffectOf(spell);
  if (summon === undefined) return { code: "unknownSpell" };

  // A ritual costs no slot; anything else spends one, the level of the spell or higher.
  const free = spell.ritual === true;
  const status = state.heroStatus[casterId] ?? { hp: caster.maxHp, resources: defaultHeroResources(caster, ctx.rules.content) };
  if (!free && (slotLevel < spell.level || slotUnavailable(spell, mergeSlots(status.resources.spellSlots, status.resources.pactSlots ?? {}), slotLevel))) return { code: "noSpellSlot", slotLevel };

  // Casting a permanent one again replaces the one the caster already has from that spell.
  const lasts = summon.permanent === true ? "dismissed" : "nextFight";
  const replaced = companionsOf(state.companions, casterId).filter((companion) => companion.spellId === spellId).map((companion) => companion.id);
  const first = (state.companions?.count ?? 0) + 1;
  const companions: Companion[] = Array.from({ length: summon.count }, (_, index) => ({
    id: `companion:${first + index}`,
    ownerId: casterId,
    monsterId: summon.monsterId,
    spellId,
    hp: null,
    lasts,
  }));
  const cast: UtilityCastRecord = { id: `cast:${state.utilityCastCount + 1}`, characterId: casterId, spellId };
  decision.emit({ kind: "companionsSummoned", companions, replaced, heroStatus: { [casterId]: free ? status : { ...status, resources: spendSlot(status.resources, slotLevel) } } });
  decision.emit({ kind: "utilitySpellCast", cast });
  decision.request({ kind: "narrateUtilityCast", castId: cast.id });
  return null;
}

function dismissCompanion(decision: Decision, characterId: CharacterId, companionId: string): Rejection | null {
  const refusal = mayCastOutsideCombat(decision, characterId);
  if (refusal !== null) return refusal;
  const companion = decision.state.companions?.members[companionId];
  if (companion === undefined || companion.ownerId !== characterId) return { code: "invalidTarget" };
  decision.emit({ kind: "companionDismissed", companionId });
  return null;
}
