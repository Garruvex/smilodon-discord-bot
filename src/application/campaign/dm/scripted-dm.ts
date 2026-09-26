import type {
  CampaignNarrator,
  CampaignPlanner,
  CombatNarratorRequest,
  NarratorRequest,
  PlannerEffect,
  PlannerProposal,
  PlannerRequest,
} from "../ports/dm-ports.js";

type Scripted<Request, Response> = Response | Error | ((request: Request) => Response);

// A scripted proposal may leave out story effects when it has none.
export type ScriptedProposal = Omit<PlannerProposal, "effects"> & { readonly effects?: readonly PlannerEffect[] };

// Test and harness stand-ins for the model calls: each call takes the next
// scripted response (a value, an Error to throw, or a function of the
// request) and records the request so tests can inspect exact payloads.
export class ScriptedPlanner implements CampaignPlanner {
  public readonly requests: PlannerRequest[] = [];

  public constructor(private readonly script: Scripted<PlannerRequest, ScriptedProposal>[]) {}

  public async plan(request: PlannerRequest): Promise<PlannerProposal> {
    this.requests.push(request);
    const proposal = await next(this.script, request, "planner");
    return { ...proposal, effects: proposal.effects ?? [] };
  }
}

export class ScriptedNarrator implements CampaignNarrator {
  public readonly requests: NarratorRequest[] = [];
  public readonly combatRequests: CombatNarratorRequest[] = [];

  public constructor(
    private readonly script: Scripted<NarratorRequest, { readonly text: string }>[],
    private readonly combatScript: Scripted<CombatNarratorRequest, { readonly text: string }>[] = [],
  ) {}

  public narrate(request: NarratorRequest): Promise<{ readonly text: string }> {
    this.requests.push(request);
    return next(this.script, request, "narrator");
  }

  public narrateCombat(request: CombatNarratorRequest): Promise<{ readonly text: string }> {
    this.combatRequests.push(request);
    return next(this.combatScript, request, "combat narrator");
  }
}

function next<Request, Response>(script: Scripted<Request, Response>[], request: Request, name: string): Promise<Response> {
  const step = script.shift();
  if (step === undefined) return Promise.reject(new Error(`The scripted ${name} has no response left.`));
  if (step instanceof Error) return Promise.reject(step);
  if (typeof step === "function") return Promise.resolve((step as (input: Request) => Response)(request));
  return Promise.resolve(step);
}
