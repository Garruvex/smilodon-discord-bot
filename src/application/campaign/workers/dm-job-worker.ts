import { skills } from "../../../domain/campaign/character/character-sheet.js";
import type { CampaignEvent } from "../../../domain/campaign/events/campaign-event.js";
import { dcLadder, rollModeReasons } from "../../../domain/campaign/rules/difficulty.js";
import { abilities } from "../../../domain/campaign/rules/effects.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import type { CampaignCommandBus } from "../campaign-command-bus.js";
import { assembleContext, defaultContextBudget, type ContextAudience } from "../dm/context-assembler.js";
import { checkLabel, roundRecords } from "../dm/round-records.js";
import type { CampaignKey, CampaignUnitOfWork, OutboxItem, StoredCampaign } from "../ports/campaign-store.js";
import type {
  AdventureCatalog,
  CampaignNarrator,
  CampaignPlanner,
  DmContext,
  NarratedOutcome,
  NarratorRequest,
} from "../ports/dm-ports.js";
import { defaultMaxAttempts, type WorkerRunResult } from "./roll-worker.js";

export interface DmJobWorkerOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly bus: CampaignCommandBus;
  readonly planner: CampaignPlanner;
  readonly narrator: CampaignNarrator;
  readonly adventures: AdventureCatalog;
  readonly glossaries: Readonly<Record<string, Glossary>>;
  readonly budgetTokens?: number;
  readonly maxAttempts?: number;
}

const system = { kind: "system" } as const;

// Runs Planner and Narrator jobs from the outbox. Model output always
// re-enters through the command bus, where the engine validates it; the
// worker never changes state itself.
export class DmJobWorker {
  public constructor(private readonly options: DmJobWorkerOptions) {}

  public async runOnce(): Promise<WorkerRunResult> {
    const { unitOfWork } = this.options;
    const items = await unitOfWork.transaction(async (tx) => [...(await tx.pendingOutbox("plan")), ...(await tx.pendingOutbox("narrate"))]);
    const failed: { id: string; error: string }[] = [];
    for (const item of items) {
      try {
        if (item.request.kind === "plan") await this.plan(item, item.request.roundNumber);
        if (item.request.kind === "narrate") await this.narrate(item, item.request.roundNumber);
        await unitOfWork.transaction((tx) => tx.completeOutbox(item.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ id: item.id, error: message });
        await unitOfWork.transaction((tx) => tx.failOutboxAttempt(item.id, message, this.maxAttempts));
      }
    }
    return { processed: items.length - failed.length, failed };
  }

  private get maxAttempts(): number {
    return this.options.maxAttempts ?? defaultMaxAttempts;
  }

  // One attempt plus one retry with the validation problems. A proposal the
  // engine still refuses holds the round for the organizer; nothing from an
  // invalid proposal is ever applied.
  private async plan(item: OutboxItem, roundNumber: number): Promise<void> {
    const loaded = await this.load(item.key);
    const round = loaded.stored.state.round;
    if (round?.status !== "planning" || round.number !== roundNumber) return;

    const actions = Object.entries(round.submissions).flatMap(([characterId, submission]) =>
      submission.kind === "action"
        ? [{ characterId, heroName: loaded.stored.state.characters[characterId]?.name ?? characterId, text: submission.text }]
        : [],
    );
    let problems: readonly string[] = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const proposal = await this.options.planner.plan({
          context: this.context("planner", loaded),
          roundNumber,
          actions,
          vocabulary: {
            abilities,
            skills,
            dcTiers: Object.keys(dcLadder),
            rollModeReasons: Object.keys(rollModeReasons),
          },
          previousProblems: problems,
        });
        const outcome = await this.options.bus.execute(
          item.key,
          { kind: "applyRoundPlan", proposal },
          { commandId: `${item.id}:plan:${attempt}`, actor: system },
        );
        if (outcome.kind !== "rejected") return;
        if (outcome.rejection.code !== "invalidPlan") return; // Stale: the round moved on.
        problems = outcome.rejection.problems;
      } catch (error) {
        problems = [`The planner call failed: ${error instanceof Error ? error.message : String(error)}`];
      }
    }
    await this.options.bus.execute(
      item.key,
      { kind: "reportPlannerFailure", roundNumber, problems },
      { commandId: `${item.id}:plan-failed`, actor: system },
    );
  }

  // If the Narrator keeps failing, the last attempt records a plain template
  // line built from committed results, so a provider outage cannot stall play.
  private async narrate(item: OutboxItem, roundNumber: number): Promise<void> {
    const loaded = await this.load(item.key);
    const request = this.narratorRequest(loaded, roundNumber);
    let text: string;
    try {
      text = (await this.options.narrator.narrate(request)).text;
    } catch (error) {
      if (item.attempts + 1 < this.maxAttempts) throw error;
      text = fallbackNarration(request);
    }
    await this.options.bus.execute(
      item.key,
      { kind: "recordNarration", roundNumber, text },
      { commandId: `${item.id}:narration`, actor: system },
    );
  }

  private narratorRequest(loaded: Loaded, roundNumber: number): NarratorRequest {
    const { state } = loaded.stored;
    const record = roundRecords(loaded.events).find((candidate) => candidate.number === roundNumber);
    const nameOf = (characterId: string): string => state.characters[characterId]?.name ?? characterId;
    const outcomes: NarratedOutcome[] = [];
    for (const [characterId, action] of record?.actions ?? []) {
      const resolution = record?.resolutions[characterId];
      if (resolution === undefined) continue;
      if (resolution.kind !== "check") {
        outcomes.push({ heroName: nameOf(characterId), action, result: { kind: resolution.kind } });
        continue;
      }
      const check = record?.checks.get(resolution.checkId);
      if (check?.result == null) continue;
      outcomes.push({
        heroName: nameOf(characterId),
        action,
        result: {
          kind: "check",
          check: checkLabel(check.test),
          total: check.result.roll.total,
          dc: check.dc,
          success: check.result.success,
          headline: check.result.moments.headline,
        },
      });
    }
    const spotlight = [...(record?.passed ?? []), ...(record?.missed ?? [])].map(nameOf);
    return { context: this.context("narrator", loaded), language: state.language, roundNumber, outcomes, spotlight };
  }

  private context(audience: ContextAudience, loaded: Loaded): DmContext {
    const glossary = this.options.glossaries[loaded.stored.state.language];
    if (glossary === undefined) throw new Error(`No glossary for ${loaded.stored.state.language}.`);
    return assembleContext({
      audience,
      state: loaded.stored.state,
      events: loaded.events,
      bible: loaded.bible,
      glossary,
      budgetTokens: this.options.budgetTokens ?? defaultContextBudget,
    });
  }

  private async load(key: CampaignKey): Promise<Loaded> {
    const { stored, envelopes } = await this.options.unitOfWork.transaction(async (tx) => ({
      stored: await tx.loadCampaign(key),
      envelopes: await tx.readEvents(key),
    }));
    if (stored === undefined) throw new Error(`Campaign ${key.campaignId} not found.`);
    const bible = this.options.adventures.find(stored.adventure.adventureId, stored.adventure.version);
    if (bible === undefined) throw new Error(`Adventure ${stored.adventure.adventureId}@${stored.adventure.version} not found.`);
    return { stored, events: envelopes.map((envelope) => envelope.event), bible };
  }
}

interface Loaded {
  readonly stored: StoredCampaign;
  readonly events: readonly CampaignEvent[];
  readonly bible: NonNullable<ReturnType<AdventureCatalog["find"]>>;
}

function fallbackNarration(request: NarratorRequest): string {
  const lines = request.outcomes.map((outcome) => {
    switch (outcome.result.kind) {
      case "automatic":
        return `${outcome.heroName}: ${outcome.action}`;
      case "impossible":
        return `${outcome.heroName}: ${outcome.action} (${request.language === "zh-TW" ? "無法做到" : "not possible"})`;
      case "check": {
        const zh = request.language === "zh-TW";
        const verdict = outcome.result.success ? (zh ? "成功" : "success") : zh ? "失敗" : "failure";
        return `${outcome.heroName}: ${outcome.action} (${outcome.result.check} ${outcome.result.total} / DC ${outcome.result.dc}, ${verdict})`;
      }
      default:
        return outcome.heroName;
    }
  });
  return lines.length > 0 ? lines.join("\n") : request.language === "zh-TW" ? "冒險繼續。" : "The adventure continues.";
}
