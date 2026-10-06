import type { CombatCommand } from "../../../domain/campaign/commands/campaign-command.js";
import type { CharacterId } from "../../../domain/campaign/core/ids.js";
import type { ContentId } from "../../../domain/campaign/rules/content-id.js";

// What a player can pick on their turn, and the engine command it becomes. Any front end uses this, so the choice-to-command
// mapping lives in one place. It never grants authority: the engine checks every command again.

export type TurnChoice =
  | { readonly kind: "attack"; readonly weapon: string }
  | { readonly kind: "cast"; readonly spell: string; readonly slot: number }
  // The spellbook: a hero with many spells picks from a page of them (renderSpellMenu).
  | { readonly kind: "spells"; readonly page: number }
  // Wild Shape: a beast to become, the beasts to choose from, or a return to the druid's own form.
  | { readonly kind: "shape"; readonly monster: string }
  | { readonly kind: "shapes"; readonly page: number }
  // The rest of the main menu, when it holds more actions than one menu can show.
  | { readonly kind: "more"; readonly page: number }
  | { readonly kind: "unshape" }
  | { readonly kind: "feature"; readonly feature: string }
  | { readonly kind: "potion"; readonly item: string }
  | { readonly kind: "move"; readonly zone: string }
  // A spell that carries the hero to a zone (Misty Step).
  | { readonly kind: "teleport"; readonly spell: string; readonly slot: number; readonly zone: string }
  | { readonly kind: "shield"; readonly item: string; readonly on: boolean }
  | { readonly kind: "engage" }
  | { readonly kind: "withdraw" }
  | { readonly kind: "dodge" }
  | { readonly kind: "dash" }
  | { readonly kind: "disengage" }
  | { readonly kind: "end" };

export // The engine command for a picked action; null when a target it needs is missing.
function combatCommand(choice: TurnChoice, targetIds: readonly string[]): ((combatantId: CharacterId) => CombatCommand) | null {
  const first = targetIds[0];
  switch (choice.kind) {
    case "attack":
      return first === undefined
        ? null
        : (combatantId): CombatCommand =>
            choice.weapon.startsWith("offhand:")
              ? { kind: "combatAttack", combatantId, targetId: first, weapon: choice.weapon.slice("offhand:".length) as ContentId<"item">, offHand: true }
              : choice.weapon.startsWith("nonlethal:")
                ? { kind: "combatAttack", combatantId, targetId: first, weapon: choice.weapon.slice("nonlethal:".length) as ContentId<"item">, nonlethal: true }
                : { kind: "combatAttack", combatantId, targetId: first, weapon: choice.weapon as ContentId<"item"> };
    case "cast":
      return targetIds.length === 0 ? null : (combatantId): CombatCommand => ({ kind: "combatCast", combatantId, spellId: choice.spell as ContentId<"spell">, slotLevel: choice.slot, targetIds });
    case "engage":
      return first === undefined ? null : (combatantId): CombatCommand => ({ kind: "combatEngage", combatantId, targetId: first });
    case "feature":
      return (combatantId): CombatCommand => ({ kind: "combatUseFeature", combatantId, featureId: choice.feature as ContentId<"feature"> });
    case "potion":
      return (combatantId): CombatCommand => ({ kind: "combatUseItem", combatantId, itemId: choice.item as ContentId<"item"> });
    case "move":
      return (combatantId): CombatCommand => ({ kind: "combatMove", combatantId, zoneId: choice.zone });
    case "teleport":
      return (combatantId): CombatCommand => ({ kind: "combatCast", combatantId, spellId: choice.spell as ContentId<"spell">, slotLevel: choice.slot, targetIds: [combatantId], zoneId: choice.zone });
    case "shield":
      return (combatantId): CombatCommand => ({ kind: "combatShield", combatantId, itemId: choice.item as ContentId<"item">, on: choice.on });
    case "withdraw":
      return (combatantId): CombatCommand => ({ kind: "combatWithdraw", combatantId });
    case "dodge":
      return (combatantId): CombatCommand => ({ kind: "combatDodge", combatantId });
    case "dash":
      return (combatantId): CombatCommand => ({ kind: "combatDash", combatantId });
    case "disengage":
      return (combatantId): CombatCommand => ({ kind: "combatDisengage", combatantId });
    case "end":
      return (combatantId): CombatCommand => ({ kind: "endTurn", combatantId });
    case "shape":
      return (combatantId): CombatCommand => ({ kind: "combatWildShape", combatantId, monsterId: choice.monster as ContentId<"monster"> });
    case "unshape":
      return (combatantId): CombatCommand => ({ kind: "combatWildShape", combatantId });
    case "spells":
    case "shapes":
    case "more":
      return null;
  }
}
