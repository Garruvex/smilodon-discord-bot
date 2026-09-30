// A fight's authored beats: foes that arrive, a truce, story effects, and a line for the table. Each trigger fires once.
import type { EncounterMonster, EncounterTrigger } from "../../commands/campaign-command.js";
import type { EncounterState } from "../../combat/combat-state.js";
import { monsterCombatant } from "../../combat/combatant-profile.js";
import type { Decision } from "../decision.js";

const isDefeated = (encounter: EncounterState): number =>
  Object.values(encounter.combatants).filter((combatant) => combatant.side === "foes" && (combatant.condition === "dead" || combatant.condition === "stable")).length;

// Fires the triggers whose condition now holds. True when one of them ended the fight in the party's favour.
export function fireTriggers(decision: Decision, encounter: EncounterState): boolean {
  const triggers: readonly EncounterTrigger[] = encounter.spec.triggers ?? [];
  let ended = false;
  triggers.forEach((trigger, index) => {
    const current = decision.state.encounter;
    if (ended || current === null || (current.triggersFired ?? []).includes(index)) return;
    const due = trigger.when.kind === "foesDown" ? isDefeated(current) >= trigger.when.count : current.round >= trigger.when.round;
    if (!due) return;
    decision.emit({ kind: "encounterTriggerFired", index });
    for (const effect of trigger.effects) {
      switch (effect.kind) {
        case "addMonsters":
          addMonsters(decision, index, effect.monsters);
          break;
        case "endFight":
          ended = true;
          break;
        case "announce":
          decision.request({ kind: "deliver", delivery: { kind: "fightNotice", encounterId: encounter.id, text: effect.text } });
          break;
        default:
          decision.applyStory(decision.state.lastRoundNumber, effect);
      }
    }
  });
  return ended;
}

// New foes join at the end of the turn order and act from the next turn round.
function addMonsters(decision: Decision, triggerIndex: number, monsters: readonly EncounterMonster[]): void {
  const content = decision.ctx.rules.content;
  monsters.forEach((entry, position) => {
    const encounter = decision.state.encounter;
    const monster = content.find(entry.monsterId);
    if (encounter === null || monster?.kind !== "monster") return;
    const slug = entry.monsterId.slice("monster:".length);
    const id = `${slug}-t${triggerIndex}-${position + 1}`;
    const summonerId = encounter.order[encounter.order.length - 1];
    if (summonerId === undefined) return;
    const combatant = monsterCombatant(monster, content, { id, letter: null, zoneId: entry.zoneId, npcId: entry.npcId, fleeBelowHpFraction: entry.fleeBelowHpFraction, ...(entry.stats === undefined ? {} : { stats: entry.stats }) });
    decision.emit({ kind: "combatantSummoned", summonerId, combatant: { ...combatant, initiative: 0 } });
    decision.request({ kind: "monsterImage", monsterId: entry.monsterId, npcId: entry.npcId });
  });
}
