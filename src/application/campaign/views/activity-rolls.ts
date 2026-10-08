import type { CheckTest } from "../../../domain/campaign/character/character-sheet.js";
import type { CampaignEvent } from "../../../domain/campaign/events/campaign-event.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";

// Every roll the viewer's own hero made, in one shape, so the Activity shows them all the same way (one toast, one tumble) whatever rolled them:
// an ability check, a press at an NPC, an attack, its damage, a death save, initiative, Hit Dice, a healing spell, a haggle, a hazard's save and what a hazard did. The page adds nothing of its
// own per kind except the title, so a new kind of roll shows up by being listed here.
export type ActivityRollKind = "check" | "press" | "attack" | "damage" | "deathSave" | "initiative" | "hitDice" | "healing" | "haggle" | "hazard" | "hazardDamage";

export interface ActivityRoll {
  readonly id: string;
  readonly kind: ActivityRollKind;
  // Only for the kinds that are a test of an ability or skill (check, press).
  readonly test?: CheckTest;
  // What a weapon, spell or other name the roll belongs to, in the campaign language (an attack's weapon, a healing spell).
  readonly using?: string;
  // The natural d20, for the rolls that are one; null for a pool of dice.
  readonly natural: number | null;
  readonly total: number;
  // What the total was up against: a check's DC. Null when nothing is set against it (damage, healing, initiative) or the target's number is not kept.
  readonly dc: number | null;
  // Whether it worked: a check passed, an attack landed, a death save held. Null for a roll that only has a total.
  readonly success: boolean | null;
  readonly moment: "natural20" | "natural1" | null;
}

type Moment = { readonly headline?: { readonly kind: string } | null } | undefined;
const momentOf = (moments: Moment): ActivityRoll["moment"] => (moments?.headline?.kind === "natural20" || moments?.headline?.kind === "natural1" ? moments.headline.kind : null);

// How many of the hero's newest rolls are offered at a time: enough that a fast round (attack, damage, a save) is not missed, few enough to be a trickle.
const newest = 6;

export function buildActivityRolls(state: CampaignState, events: readonly CampaignEvent[], characterId: string, glossary: Glossary): readonly ActivityRoll[] {
  const named = (id: string): string => glossary.names[id] ?? id.replace(/^[a-z]+:/, "").replaceAll("-", " ");

  const checks: ActivityRoll[] = Object.values(state.checks)
    .filter((check) => check.characterId === characterId && check.result !== null)
    .sort((a, b) => a.roundNumber - b.roundNumber)
    .slice(-3)
    .map((check) => ({ id: check.id, kind: "check" as const, test: check.test, natural: check.result!.roll.d20.natural, total: check.result!.roll.total, dc: check.dc, success: check.result!.success, moment: momentOf(check.result!.moments) }));
  const presses: ActivityRoll[] = Object.values(state.dialogues)
    .filter((dialogue) => dialogue.characterId === characterId && dialogue.check?.natural !== undefined)
    .slice(-1)
    .map((dialogue) => ({ id: dialogue.id, kind: "press" as const, test: dialogue.check!.test, natural: dialogue.check!.natural!, total: dialogue.check!.total, dc: dialogue.check!.dc, success: dialogue.check!.success, moment: momentOf(dialogue.check!.moments) }));

  // The rest come from the event log, where each roll was recorded as it landed. The event's place in the log is its id, so each shows once.
  const own = new Map<string, string>();
  const found: ActivityRoll[] = [];
  events.forEach((event, index) => {
    switch (event.kind) {
      case "resolutionDeclared": {
        if (event.resolution.actorId !== characterId) break;
        const { source } = event.resolution;
        const id = source.kind === "weapon" ? source.option.weapon : source.kind === "spell" ? source.spellId : source.kind === "area" ? source.area.weapon : source.kind === "item" ? source.itemId : source.featureId;
        own.set(event.resolution.id, named(String(id)));
        break;
      }
      case "checkRolled": {
        const using = own.get(event.resolutionId);
        if (using === undefined) break;
        found.push({ id: `attack:${index}`, kind: "attack", using, natural: event.roll.d20.natural, total: event.roll.total, dc: null, success: event.landed, moment: momentOf(event.moments) });
        break;
      }
      case "effectRolled": {
        const using = own.get(event.resolutionId);
        if (using === undefined || event.value <= 0) break;
        found.push({ id: `damage:${index}`, kind: "damage", using, natural: null, total: event.value, dc: null, success: null, moment: null });
        break;
      }
      case "deathSaveRolled":
        if (event.combatantId === characterId) found.push({ id: `deathSave:${index}`, kind: "deathSave", natural: event.roll.d20.natural, total: event.roll.total, dc: 10, success: event.roll.total >= 10, moment: momentOf(event.moments) });
        break;
      case "initiativeRolled":
        if (event.combatantId === characterId) found.push({ id: `initiative:${index}`, kind: "initiative", natural: event.roll.d20.natural, total: event.roll.total, dc: null, success: null, moment: null });
        break;
      case "hitDiceSettled":
        if (event.characterId === characterId) found.push({ id: `hitDice:${index}`, kind: "hitDice", natural: null, total: event.rolled, dc: null, success: null, moment: null });
        break;
      case "healingSettled":
        if (event.healing.casterId === characterId) found.push({ id: `healing:${index}`, kind: "healing", using: named(event.healing.spellId), natural: null, total: event.healing.rolled, dc: null, success: null, moment: null });
        break;
      case "tradeSettled":
        if (event.trade.characterId === characterId && event.trade.haggle !== null && event.trade.haggle !== undefined) found.push({ id: `haggle:${index}`, kind: "haggle", test: event.trade.haggle.test, natural: null, total: event.trade.haggle.total, dc: event.trade.haggle.dc, success: event.trade.haggle.success, moment: momentOf(event.trade.haggle.moments) });
        break;
      case "hazardSettled":
        if (event.hazard.characterId === characterId) found.push({ id: `hazard:${index}`, kind: "hazard", test: { kind: "save", ability: event.hazard.ability }, natural: null, total: event.hazard.total, dc: event.hazard.dc, success: event.hazard.success, moment: momentOf(event.hazard.moments) });
        break;
      case "environmentalDamageSettled":
        if (event.damage.characterId === characterId && event.damage.rolled > 0) found.push({ id: `hazardDamage:${index}`, kind: "hazardDamage", natural: null, total: event.damage.rolled, dc: null, success: null, moment: null });
        break;
      default:
        break;
    }
  });
  return [...checks, ...presses, ...found.slice(-newest)];
}
