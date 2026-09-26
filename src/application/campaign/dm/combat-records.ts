import type { AdventureBible } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { Combatant, CombatantCondition, EncounterOutcome } from "../../../domain/campaign/combat/combat-state.js";
import type { RollMoment } from "../../../domain/campaign/dice/roll-moments.js";
import type { CampaignEvent } from "../../../domain/campaign/events/campaign-event.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";

// What happened in a fight, rebuilt from the event log: the source for
// combat flourishes and for the transcript layer. Everything here is public
// (the table saw the template lines); no DM notes or tactics.
export interface EncounterRecord {
  readonly id: string;
  // The exploration round that led into the fight.
  readonly afterRound: number;
  readonly rounds: CombatRoundRecord[];
  outcome: EncounterOutcome | null;
  // The closing narration, once recorded.
  closing: string | null;
}

export interface CombatRoundRecord {
  readonly round: number;
  readonly beats: CombatBeat[];
  narration: string | null;
}

export type CombatBeat =
  | {
      readonly kind: "action";
      readonly actor: string;
      // Weapon, spell, or feature name in the campaign language.
      readonly using: string;
      readonly opportunity: boolean;
      readonly targets: CombatTargetResult[];
      headline: RollMoment | null;
    }
  | { readonly kind: "maneuver"; readonly actor: string; readonly maneuver: "dash" | "dodge" | "disengage" | "giveItem" | "useItem" }
  | { readonly kind: "fled"; readonly actor: string }
  | { readonly kind: "deathSave"; readonly actor: string; readonly condition: CombatantCondition; readonly headline: RollMoment | null };

export interface CombatTargetResult {
  readonly name: string;
  // Attack: hit, critical, or miss; save: saved or failed; null without a check.
  check: "hit" | "critical" | "miss" | "saved" | "failed" | null;
  // Net HP change from this action: negative for damage.
  hpChange: number;
  // Set when the action changed the target's state (downed, killed, revived).
  condition: CombatantCondition | null;
  knockedProne: boolean;
}

export interface CombatNames {
  readonly state: CampaignState;
  readonly bible: AdventureBible;
  readonly glossary: Glossary;
}

// Heroes by name, named NPCs by their bible name, other monsters by their
// glossary name plus letter ("Goblin A").
export function combatantName(combatant: Combatant, names: CombatNames): string {
  const { source } = combatant;
  if (source.kind === "hero") return names.state.characters[source.characterId]?.name ?? combatant.id;
  const npc = source.npcId === null ? undefined : names.bible.npcs.find((candidate) => candidate.id === source.npcId);
  if (npc !== undefined) return npc.name;
  const base = names.glossary.names[source.monsterId] ?? source.monsterId;
  return combatant.letter === null ? base : `${base} ${combatant.letter}`;
}

export function encounterRecords(events: readonly CampaignEvent[], names: CombatNames): readonly EncounterRecord[] {
  const records: EncounterRecord[] = [];
  let lastRound = 0;
  let current: EncounterRecord | null = null;
  let combatants: Readonly<Record<string, Combatant>> = {};
  let action: Extract<CombatBeat, { kind: "action" }> | null = null;
  let actionTargets = new Map<string, CombatTargetResult>();
  let checkKinds: Readonly<Record<string, "attack" | "save">> = {};
  const nameOf = (id: string): string => {
    const combatant = combatants[id];
    return combatant === undefined ? id : combatantName(combatant, names);
  };
  const roundOf = (record: EncounterRecord, round: number): CombatRoundRecord => {
    let found = record.rounds.find((candidate) => candidate.round === round);
    if (found === undefined) {
      found = { round, beats: [], narration: null };
      record.rounds.push(found);
    }
    return found;
  };
  let round = 1;
  const push = (beat: CombatBeat): void => {
    if (current !== null) roundOf(current, round).beats.push(beat);
  };
  const targetOf = (id: string): CombatTargetResult => {
    let target = actionTargets.get(id);
    if (target === undefined) {
      target = { name: nameOf(id), check: null, hpChange: 0, condition: null, knockedProne: false };
      actionTargets.set(id, target);
      action?.targets.push(target);
    }
    return target;
  };

  for (const event of events) {
    switch (event.kind) {
      case "roundOpened":
        lastRound = event.roundNumber;
        break;
      case "encounterStarted":
        current = { id: event.encounter.id, afterRound: lastRound, rounds: [], outcome: null, closing: null };
        combatants = event.encounter.combatants;
        round = 1;
        records.push(current);
        break;
      case "encounterRetried": {
        // The set-aside attempt never happened as far as the story goes.
        const index = records.findIndex((record) => record.id === event.encounterId);
        if (index >= 0) records.splice(index, 1);
        current = null;
        break;
      }
      case "turnStarted":
        round = event.round;
        break;
      case "actionTaken":
        push({ kind: "maneuver", actor: nameOf(event.combatantId), maneuver: event.action });
        break;
      case "resolutionDeclared": {
        const { resolution } = event;
        const source = resolution.source;
        const id = source.kind === "weapon" ? source.option.weapon : source.kind === "spell" ? source.spellId : source.featureId;
        action = {
          kind: "action",
          actor: nameOf(resolution.actorId),
          using: names.glossary.names[id] ?? id,
          opportunity: resolution.purpose === "opportunity",
          targets: [],
          headline: null,
        };
        actionTargets = new Map();
        checkKinds = Object.fromEntries(Object.entries(resolution.checks).map(([rollId, check]) => [rollId, check.kind]));
        for (const targetId of resolution.targetIds) targetOf(targetId);
        push(action);
        break;
      }
      case "checkRolled": {
        if (action === null) break;
        const target = targetOf(event.targetId);
        // A check "lands" when the attack hits or the target fails its save.
        if (checkKinds[event.rollId] === "save") target.check = event.landed ? "failed" : "saved";
        else target.check = event.critical ? "critical" : event.landed ? "hit" : "miss";
        action.headline ??= event.moments.headline;
        break;
      }
      case "combatantHpChanged": {
        if (action === null || event.cause === "protectedWhileAway") break;
        const target = targetOf(event.combatantId);
        target.hpChange += event.change;
        if (event.condition !== "active" || event.change > 0) target.condition = event.condition;
        break;
      }
      case "conditionAdded":
        if (action !== null && event.condition === "condition:prone") targetOf(event.combatantId).knockedProne = true;
        break;
      case "resolutionFinished":
        action = null;
        break;
      case "deathSaveRolled":
        push({ kind: "deathSave", actor: nameOf(event.combatantId), condition: event.condition, headline: event.moments.headline });
        break;
      case "combatantFled":
        push({ kind: "fled", actor: nameOf(event.combatantId) });
        break;
      case "encounterEnded":
        if (current !== null) current.outcome = event.outcome;
        break;
      case "combatNarrationRecorded":
        if (current === null) break;
        if (event.final) current.closing = event.text;
        else roundOf(current, event.round).narration = event.text;
        break;
      default:
        break;
    }
  }
  return records;
}

