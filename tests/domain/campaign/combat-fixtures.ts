import type { Actor, CampaignCommand, EncounterSpec } from "../../../src/domain/campaign/commands/campaign-command.js";
import type { Combatant, EncounterState } from "../../../src/domain/campaign/combat/combat-state.js";
import { multiplyDice, type DiceExpression } from "../../../src/domain/campaign/dice/dice-expression.js";
import type { ExpressionRoll } from "../../../src/domain/campaign/dice/roll.js";
import type { RollResult, RollSpec } from "../../../src/domain/campaign/dice/roll-spec.js";
import { decide } from "../../../src/domain/campaign/engine/decide.js";
import type { EngineRequest } from "../../../src/domain/campaign/engine/engine-request.js";
import type { Rejection } from "../../../src/domain/campaign/engine/rejection.js";
import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import { replay } from "../../../src/domain/campaign/events/evolve.js";
import type { SealedRuleset } from "../../../src/domain/campaign/rules/ruleset.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { newCampaign, organizer, ruleset, system } from "./campaign-fixtures.js";

// Gate and courtyard 20 ft apart: a hero can cross and engage (20 + 10 = 30 ft).
export const skirmish: EncounterSpec = {
  id: "enc-1",
  zones: [
    { id: "gate", name: "Gate" },
    { id: "courtyard", name: "Courtyard" },
  ],
  edges: [{ from: "gate", to: "courtyard", feet: 20 }],
  partyZoneId: "gate",
  monsters: [
    { monsterId: "monster:goblin", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null },
    { monsterId: "monster:goblin", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null },
  ],
};

// Drives a fight: runs commands, then feeds every roll the engine asks for
// from scripted dice, the way the roll worker would, until play waits for a
// player. Every step is replayed through evolve() to prove they agree.
export class Fight {
  public state: CampaignState;
  public readonly events: CampaignEvent[] = [];
  public readonly requests: EngineRequest[] = [];
  private readonly d20s: number[] = [];
  private readonly dice: number[] = [];

  public constructor(
    state: CampaignState = newCampaign(),
    private readonly rules: SealedRuleset = ruleset(),
  ) {
    this.state = state;
  }

  public rolls(d20s: readonly number[], dice: readonly number[] = []): this {
    this.d20s.push(...d20s);
    this.dice.push(...dice);
    return this;
  }

  public run(actor: Actor, command: CampaignCommand, now = 0): this {
    const pending = this.apply(actor, command, now);
    while (pending.length > 0) {
      const request = pending.shift();
      if (request?.kind !== "roll") continue;
      pending.push(...this.apply(system, { kind: "recordRoll", rollId: request.rollId, result: this.result(request.spec) }, now));
    }
    return this;
  }

  public reject(actor: Actor, command: CampaignCommand): Rejection {
    const result = decide(this.state, command, { rules: this.rules, now: 0, actor });
    if (result.kind !== "rejected") throw new Error(`Expected ${command.kind} to be rejected.`);
    return result.rejection;
  }

  public get encounter(): EncounterState {
    if (this.state.encounter === null) throw new Error("No encounter.");
    return this.state.encounter;
  }

  public combatant(id: string): Combatant {
    const combatant = this.encounter.combatants[id];
    if (combatant === undefined) throw new Error(`No combatant ${id}.`);
    return combatant;
  }

  public get current(): string | undefined {
    return this.encounter.order[this.encounter.turnIndex];
  }

  public kinds(): readonly string[] {
    return this.events.map((event) => event.kind);
  }

  private apply(actor: Actor, command: CampaignCommand, now: number): EngineRequest[] {
    const result = decide(this.state, command, { rules: this.rules, now, actor });
    if (result.kind === "rejected") throw new Error(`${command.kind} rejected: ${JSON.stringify(result.rejection)}`);
    this.state = replay(this.state, result.events);
    this.events.push(...result.events);
    this.requests.push(...result.requests);
    return [...result.requests];
  }

  private result(spec: RollSpec): RollResult {
    if (spec.kind === "d20Test") {
      const count = spec.spec.mode === "normal" ? 1 : 2;
      const values = Array.from({ length: count }, () => this.d20s.shift() ?? 10);
      const natural = spec.spec.mode === "advantage" ? Math.max(...values) : Math.min(...values);
      const d20Total = natural + spec.spec.modifier;
      // Bonus dice (Bless) take their faces from the dice queue.
      const bonusDice = spec.spec.bonusDice.map((bonus) => ({ source: bonus.source, roll: this.expression(bonus.die) }));
      return {
        kind: "d20Test",
        roll: {
          d20: { mode: spec.spec.mode, values, natural, modifier: spec.spec.modifier, total: d20Total },
          bonusDice,
          total: d20Total + bonusDice.reduce((sum, bonus) => sum + bonus.roll.total, 0),
        },
      };
    }
    return { kind: "dice", roll: this.expression(spec.critical ? multiplyDice(spec.expression, 2) : spec.expression) };
  }

  private expression(expression: DiceExpression): ExpressionRoll {
    const terms = expression.terms.map((term) => ({ sides: term.sides, values: Array.from({ length: term.count }, () => this.dice.shift() ?? 1) }));
    const total = expression.modifier + terms.reduce((sum, term) => sum + term.values.reduce((a, b) => a + b, 0), 0);
    return { expression, terms, modifier: expression.modifier, total };
  }
}

// Every action declared so far: who, at whom, and the attack roll's mode.
export function declared(fight: Fight): { actor: string; target: string | undefined; mode: string | undefined }[] {
  return fight.events.flatMap((event) =>
    event.kind === "resolutionDeclared"
      ? [{ actor: event.resolution.actorId, target: event.resolution.targetIds[0], mode: Object.values(event.resolution.checks)[0]?.spec.mode }]
      : [],
  );
}

export function heroHp(fight: Fight): Record<string, number> {
  return Object.fromEntries(Object.entries(fight.state.heroStatus).map(([id, status]) => [id, status.hp]));
}

// Initiative order used by most tests: Mira 20, Borin 15, goblins 5 and 4.
export function startedFight(state?: CampaignState): Fight {
  return new Fight(state).rolls([20, 15, 5, 4]).run(organizer, { kind: "startEncounter", spec: skirmish });
}
