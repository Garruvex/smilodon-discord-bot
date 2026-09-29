import { encounterSpec, type BibleEncounter } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { CampaignCommand } from "../../../domain/campaign/commands/campaign-command.js";
import { isActive } from "../../../domain/campaign/combat/combat-state.js";
import { performRoll } from "../../../domain/campaign/dice/roll-spec.js";
import { decide } from "../../../domain/campaign/engine/decide.js";
import type { EngineRequest } from "../../../domain/campaign/engine/engine-request.js";
import { replay } from "../../../domain/campaign/events/evolve.js";
import type { SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import { resolveHouseRules } from "../../../domain/campaign/rules/house-rules.js";
import type { SealedRuleset } from "../../../domain/campaign/rules/ruleset.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";
import { SeededRandomSource } from "../random/seeded-random-source.js";
import { chooseHeroCommand, type HarnessCombatRole } from "../harness/harness-tactics.js";
import { buildStartingState } from "../setup/starting-state.js";
import type { AdventureDocument } from "./adventure-document.js";

export type RehearsalOutcome = "victory" | "defeat" | "stuck" | "rejected";

export interface RehearsalResult {
  readonly encounterId: string;
  readonly outcome: RehearsalOutcome;
  // Rounds the fight lasted, and how much of the party's HP was left.
  readonly rounds: number;
  readonly partyHpLeft: number;
  readonly partyHpMax: number;
  // Why the rehearsal could not finish, when it could not.
  readonly problem: string | null;
}

const roleFor = (className: string | undefined): HarnessCombatRole => (className === "rogue" ? "skirmisher" : className === "cleric" ? "healer" : "striker");
const noTimers = { roundSeconds: null, rollSeconds: null, turnSeconds: null, awayAfterMisses: 2 } as const;
const maxSteps = 800;

// A headless rehearsal of one authored fight (plan §3, uploaded adventures:
// "a headless smoke run"). The adventure's own preset heroes fight it with
// scripted tactics through the real engine, with seeded dice, and the fight
// has to start, follow the rules, and reach an end. It says nothing about
// whether the fight is fun; a fight that cannot be finished is a mistake in
// the adventure, found before any player meets it.
export function rehearseEncounter(document: AdventureDocument, encounter: BibleEncounter, content: SealedContent, seed: number): RehearsalResult {
  const rules: SealedRuleset = { content, houseRules: resolveHouseRules({}) };
  const seats = document.heroes.slice(0, 3).map((hero, index) => ({ userId: `rehearsal-${index + 1}`, heroId: hero.id }));
  let state: CampaignState = buildStartingState({ campaignId: "rehearsal", organizerId: "rehearsal-1", adventure: document, seats, pacing: noTimers });
  const random = new SeededRandomSource(seed);
  const finish = (outcome: RehearsalOutcome, problem: string | null): RehearsalResult => {
    const fight = state.encounter;
    const heroes = Object.values(fight?.combatants ?? {}).filter((combatant) => combatant.side === "party");
    return {
      encounterId: encounter.id,
      outcome,
      rounds: fight?.round ?? 0,
      partyHpLeft: heroes.reduce((sum, hero) => sum + hero.hp, 0),
      partyHpMax: heroes.reduce((sum, hero) => sum + hero.maxHp, 0),
      problem,
    };
  };

  // Applies one command, then the dice it asks for, the way the roll worker does.
  const apply = (actor: { kind: "user"; userId: string } | { kind: "system" }, command: CampaignCommand): string | null => {
    const pending: { actor: typeof actor; command: CampaignCommand }[] = [{ actor, command }];
    for (let guard = 0; pending.length > 0; guard += 1) {
      if (guard > maxSteps) return "The fight kept asking for dice without settling.";
      const next = pending.shift();
      if (next === undefined) break;
      const result = decide(state, next.command, { rules, now: 0, actor: next.actor });
      if (result.kind === "rejected") return `The engine refused ${next.command.kind}: ${result.rejection.code}.`;
      state = replay(state, result.events);
      for (const request of result.requests) {
        if (request.kind === "roll") pending.push({ actor: { kind: "system" }, command: rollCommand(request, random) });
      }
    }
    return null;
  };

  const started = apply({ kind: "user", userId: "rehearsal-1" }, { kind: "startEncounter", spec: encounterSpec(encounter) });
  if (started !== null) return finish("rejected", started);

  for (let step = 0; step < maxSteps; step += 1) {
    const fight = state.encounter;
    if (fight === null || fight.status === "ended") {
      return finish(fight?.outcome === "victory" ? "victory" : "defeat", null);
    }
    const current = fight.combatants[fight.order[fight.turnIndex] ?? ""];
    if (current === undefined || current.source.kind !== "hero" || !isActive(current)) return finish("stuck", "The fight stopped waiting for something that cannot happen.");
    const owner = state.characters[current.source.characterId]?.ownerUserId;
    if (owner === undefined) return finish("stuck", "A hero has no player.");
    const sheet = state.characters[current.source.characterId];
    const problem = apply({ kind: "user", userId: owner }, chooseHeroCommand(fight, current, roleFor(sheet?.className), content));
    if (problem !== null) return finish("rejected", problem);
  }
  return finish("stuck", "The fight went on for too many steps without ending.");
}

function rollCommand(request: Extract<EngineRequest, { kind: "roll" }>, random: SeededRandomSource): CampaignCommand {
  return { kind: "recordRoll", rollId: request.rollId, result: performRoll(request.spec, random) };
}
