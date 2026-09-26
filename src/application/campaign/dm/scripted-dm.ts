import type { RoundPlanProposal } from "../../../domain/campaign/commands/campaign-command.js";
import type { CampaignNarrator, CampaignPlanner, NarratorRequest, PlannerRequest } from "../ports/dm-ports.js";

type Scripted<Request, Response> = Response | Error | ((request: Request) => Response);

// Test and harness stand-ins for the model calls: each call takes the next
// scripted response (a value, an Error to throw, or a function of the
// request) and records the request so tests can inspect exact payloads.
export class ScriptedPlanner implements CampaignPlanner {
  public readonly requests: PlannerRequest[] = [];

  public constructor(private readonly script: Scripted<PlannerRequest, RoundPlanProposal>[]) {}

  public plan(request: PlannerRequest): Promise<RoundPlanProposal> {
    this.requests.push(request);
    return next(this.script, request, "planner");
  }
}

export class ScriptedNarrator implements CampaignNarrator {
  public readonly requests: NarratorRequest[] = [];

  public constructor(private readonly script: Scripted<NarratorRequest, { readonly text: string }>[]) {}

  public narrate(request: NarratorRequest): Promise<{ readonly text: string }> {
    this.requests.push(request);
    return next(this.script, request, "narrator");
  }
}

function next<Request, Response>(script: Scripted<Request, Response>[], request: Request, name: string): Promise<Response> {
  const step = script.shift();
  if (step === undefined) return Promise.reject(new Error(`The scripted ${name} has no response left.`));
  if (step instanceof Error) return Promise.reject(step);
  if (typeof step === "function") return Promise.resolve((step as (input: Request) => Response)(request));
  return Promise.resolve(step);
}
