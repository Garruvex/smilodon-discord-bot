import type { RulesetCatalog } from "../rules/ruleset-catalog.js";
import { findEncounter, findScene } from "../../../domain/campaign/adventure/adventure-bible.js";
import { skills } from "../../../domain/campaign/character/character-sheet.js";
import type { CampaignEvent } from "../../../domain/campaign/events/campaign-event.js";
import { dcLadder, rollModeReasons } from "../../../domain/campaign/rules/difficulty.js";
import { abilities } from "../../../domain/campaign/rules/effects.js";
import { lootGold } from "../../../domain/campaign/rules/house-rules.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import type { SceneId } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { CampaignCommandBus } from "../campaign-command-bus.js";
import { assembleContext, defaultContextBudget, renderTranscript, type ContextAudience } from "../dm/context-assembler.js";
import { latestSummaryRound } from "../../../domain/campaign/engine/dm.js";
import { sceneNoteCompactionThreshold } from "../../../domain/campaign/engine/dm.js";
import { encounterRecords } from "../dm/combat-records.js";
import { checkLabel, roundRecords } from "../dm/round-records.js";
import { fallbackPlan } from "../dm/fallback-planner.js";
import { plannerStory, resolveStoryEffects } from "../dm/story-effects.js";
import type { RuntimeLogger } from "../campaign-runtime.js";
import type { CampaignKey, CampaignUnitOfWork, OutboxItem, StoredCampaign } from "../ports/campaign-store.js";
import type {
  AdventureCatalog,
  CampaignChronicler,
  CampaignNarrator,
  CampaignPlanner,
  CampaignSceneNoteJudge,
  CombatNarratorRequest,
  DialogueNarratorRequest,
  DmContext,
  HazardNarratorRequest,
  NarratedOutcome,
  NarratorRequest,
  PlannerRequest,
  TradeNarratorRequest,
  UtilityCastNarratorRequest,
} from "../ports/dm-ports.js";
import { defaultMaxAttempts, type WorkerRunResult } from "./roll-worker.js";

export interface DmJobWorkerOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly bus: CampaignCommandBus;
  readonly planner: CampaignPlanner;
  readonly narrator: CampaignNarrator;
  // Condenses rounds in the background; without one, summaries are simply not made.
  readonly chronicler?: CampaignChronicler;
  readonly noteJudge?: CampaignSceneNoteJudge;
  readonly adventures: AdventureCatalog;
  readonly glossaries: Readonly<Record<string, Glossary>>;
  // Resolves each campaign's pinned ruleset, so the narrator can be given reference cards for the monsters in a fight.
  readonly rulesets?: RulesetCatalog;
  readonly budgetTokens?: number;
  readonly maxAttempts?: number;
  // Chance for the tables an adventure rolls on (0 up to but excluding 1); tests pin it.
  readonly random?: () => number;
  // Where a failed planning attempt is written, so the reason is not lost with the organizer notice.
  readonly logger?: RuntimeLogger;
}

const system = { kind: "system" } as const;

// Runs Planner and Narrator jobs from the outbox. Model output always
// re-enters through the command bus, where the engine validates it; the
// worker never changes state itself.
export class DmJobWorker {
  public constructor(private readonly options: DmJobWorkerOptions) {}

  public async runOnce(): Promise<WorkerRunResult> {
    const { unitOfWork } = this.options;
    const items = await unitOfWork.transaction(async (tx) => [
      ...(await tx.pendingOutbox("plan")),
      ...(await tx.pendingOutbox("narrateOpening")),
      ...(await tx.pendingOutbox("narrate")),
      ...(await tx.pendingOutbox("narrateCombat")),
      ...(await tx.pendingOutbox("narrateTrade")),
      ...(await tx.pendingOutbox("narrateDialogue")),
      ...(await tx.pendingOutbox("narrateUtilityCast")),
      ...(await tx.pendingOutbox("narrateHazard")),
      ...(await tx.pendingOutbox("chronicle")),
      ...(await tx.pendingOutbox("compactSceneNotes")),
      ...(await tx.pendingOutbox("renarrate")),
      ...(await tx.pendingOutbox("judgeSceneNotes")),
    ]);
    const failed: { id: string; error: string }[] = [];
    for (const item of items) {
      try {
        if (item.request.kind === "plan") await this.plan(item, item.request.roundNumber);
        if (item.request.kind === "narrateOpening") await this.narrateOpening(item);
        if (item.request.kind === "narrate") await this.narrate(item, item.request.roundNumber);
        if (item.request.kind === "narrateCombat") await this.narrateCombat(item, item.request.encounterId, item.request.round, item.request.final);
        if (item.request.kind === "narrateTrade") await this.narrateTrade(item, item.request.tradeId);
        if (item.request.kind === "narrateDialogue" && !(await this.narrateDialogue(item, item.request.dialogueId))) continue;
        if (item.request.kind === "narrateUtilityCast") await this.narrateUtilityCast(item, item.request.castId);
        if (item.request.kind === "narrateHazard") await this.narrateHazard(item, item.request.hazardId);
        if (item.request.kind === "chronicle") await this.chronicle(item, item.request.throughRound, item.request.privateOnly ?? false);
        if (item.request.kind === "compactSceneNotes") await this.compactSceneNotes(item, item.request.sceneId, item.request.throughRound);
        if (item.request.kind === "judgeSceneNotes") await this.judgeSceneNotes(item, item.request.roundNumber, item.request.sceneId);
        if (item.request.kind === "renarrate") await this.renarrate(item, item.request.roundNumber);
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
    // An organizer retry is a new job, but it must retain the last failure's
    // feedback instead of asking the model to repeat the same invalid plan.
    const previousFailure = loaded.events.findLast((event) => event.kind === "plannerFailed" && event.roundNumber === roundNumber);
    let problems: readonly string[] = previousFailure?.kind === "plannerFailed" ? previousFailure.problems : [];
    const requestFor = (previousProblems: readonly string[]): PlannerRequest => ({
      context: this.context("planner", loaded),
      roundNumber,
      actions,
      vocabulary: {
        abilities,
        skills,
        dcTiers: Object.keys(dcLadder),
        rollModeReasons: Object.keys(rollModeReasons),
      },
      story: plannerStory(loaded.bible, loaded.stored.state),
      previousProblems,
    });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const proposal = await this.options.planner.plan(requestFor(problems));
        const wallet = loaded.stored.ruleset.houseRules[lootGold.id] === "split" ? "hero" : "pool";
        const resolved = resolveStoryEffects(proposal, loaded.bible, loaded.stored.state, { wallet, ...(this.options.random === undefined ? {} : { random: this.options.random }) });
        if (resolved.kind === "invalid") {
          problems = resolved.problems;
          this.options.logger?.warn({ campaignId: item.key.campaignId, roundNumber, attempt, problems }, "Planner proposal was invalid");
          continue;
        }
        const outcome = await this.options.bus.execute(
          item.key,
          { kind: "applyRoundPlan", proposal: resolved.proposal },
          { commandId: `${item.id}:${item.attempts}:plan:${attempt}`, actor: system },
        );
        if (outcome.kind !== "rejected") return;
        if (outcome.rejection.code !== "invalidPlan") return; // Stale: the round moved on.
        problems = outcome.rejection.problems;
        this.options.logger?.warn({ campaignId: item.key.campaignId, roundNumber, attempt, problems }, "Engine refused the round plan");
      } catch (error) {
        problems = [`The planner call failed: ${error instanceof Error ? error.message : String(error)}`];
        this.options.logger?.warn({ err: error, campaignId: item.key.campaignId, roundNumber, attempt }, "Planner call failed");
      }
    }
    // A provider hiccup should not hold the round for the organizer: the job is tried again later, and only the last try holds it.
    if (item.attempts + 1 < this.maxAttempts) throw new Error(`The planner failed: ${problems.join(" ")}`);
    // The round is not held for the organizer: it is planned without the model (plain, and only what the adventure already wrote), as a
    // narrator outage already is. Only if even that plan is refused does the round wait for the organizer.
    const wallet = loaded.stored.ruleset.houseRules[lootGold.id] === "split" ? "hero" : "pool";
    const plain = resolveStoryEffects(fallbackPlan(requestFor([])), loaded.bible, loaded.stored.state, { wallet, ...(this.options.random === undefined ? {} : { random: this.options.random }) });
    if (plain.kind === "resolved") {
      const outcome = await this.options.bus.execute(item.key, { kind: "applyRoundPlan", proposal: plain.proposal }, { commandId: `${item.id}:${item.attempts}:plan:fallback`, actor: system });
      if (outcome.kind !== "rejected" || outcome.rejection.code !== "invalidPlan") {
        this.options.logger?.error({ campaignId: item.key.campaignId, roundNumber, problems }, "The planner failed on every try; the round was planned without it");
        return;
      }
    }
    this.options.logger?.error({ campaignId: item.key.campaignId, roundNumber, problems }, "Round held: the planner failed on every try");
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
    let note = "";
    try {
      const narrated = await this.options.narrator.narrate(request);
      text = narrated.text;
      note = narrated.note ?? "";
    } catch (error) {
      if (item.attempts + 1 < this.maxAttempts) throw error;
      text = fallbackNarration(request);
    }
    await this.options.bus.execute(
      item.key,
      { kind: "recordNarration", roundNumber, text, note },
      { commandId: `${item.id}:narration`, actor: system },
    );
  }

  // Tells the last narrated round again from the same committed outcomes.
  // Only words come back: the outcomes were fixed before the first telling.
  // A failure is retried, and after the last attempt the earlier telling stands.
  private async renarrate(item: OutboxItem, roundNumber: number): Promise<void> {
    const loaded = await this.load(item.key);
    if (loaded.stored.state.lastNarratedRound !== roundNumber) return;
    const request = this.narratorRequest(loaded, roundNumber);
    let text: string;
    try {
      text = (await this.options.narrator.narrate(request)).text;
    } catch (error) {
      if (item.attempts + 1 < this.maxAttempts) throw error;
      return;
    }
    await this.options.bus.execute(item.key, { kind: "replaceNarration", roundNumber, text }, { commandId: `${item.id}:retold`, actor: system });
  }

  // Condenses the rounds since the last summary, once for the table (from what
  // it saw) and once for the DM (from everything), then keeps the ledger facts
  // they name. A public summary is written from the public transcript alone, so
  // it cannot hold a secret. The engine refuses a late or number-filled
  // summary; a fact that renames a known entity is dropped, not forced.
  private async chronicle(item: OutboxItem, throughRound: number, privateOnly = false): Promise<void> {
    const { chronicler, bus } = this.options;
    if (chronicler === undefined) return;
    const loaded = await this.load(item.key);
    const { state } = loaded.stored;
    for (const audience of (privateOnly ? ["private"] as const : ["public", "private"] as const)) {
      const visibility = audience;
      const from = latestSummaryRound(state.summaries, visibility);
      if (from >= throughRound) continue;
      const input = { audience: audience === "public" ? ("narrator" as const) : ("planner" as const), state, events: loaded.events, bible: loaded.bible, glossary: this.glossary(loaded), budgetTokens: this.options.budgetTokens ?? defaultContextBudget };
      const transcript = renderTranscript(input, from, throughRound);
      if (transcript.trim() === "") continue;
      const previous = [...(state.summaries ?? [])].reverse().find((summary) => summary.visibility === visibility)?.text ?? null;
      const known = Object.values(state.ledger).flatMap((entry) =>
        audience === "private" || entry.facts.some((fact) => fact.visibility === "public") ? [{ entityId: entry.entityId, canonicalName: entry.canonicalName }] : [],
      );
      const result = await chronicler.chronicle({ audience, language: state.language, transcript, previousSummary: previous, knownEntities: known });
      const summary = await bus.execute(item.key, { kind: "recordSummary", throughRound, visibility, text: result.summary }, { commandId: `${item.id}:summary:${audience}`, actor: system });
      // A refused summary (late, or stating numbers) is not retried: the rounds stay in the transcript.
      if (summary.kind === "rejected") continue;
      for (const [index, fact] of result.facts.entries()) {
        await bus.execute(
          item.key,
          { kind: "recordLedgerFact", entityId: fact.entityId, canonicalName: fact.canonicalName, fact: fact.fact, visibility: audience === "public" ? "public" : "secret" },
          { commandId: `${item.id}:fact:${audience}:${index}`, actor: system },
        );
      }
    }
  }

  private async compactSceneNotes(item: OutboxItem, sceneId: string, throughRound: number): Promise<void> {
    const { chronicler, bus } = this.options;
    if (chronicler === undefined) return;
    const loaded = await this.load(item.key);
    const { state } = loaded.stored;
    const previous = state.sceneSummaries?.[sceneId];
    const notes = (state.sceneNotes ?? []).filter((note) => note.sceneId === sceneId && note.roundNumber > (previous?.throughRound ?? 0) && note.roundNumber <= throughRound);
    if (notes.length === 0 || notes.reduce((sum, note) => sum + note.text.length, 0) < sceneNoteCompactionThreshold) return;
    const scene = findScene(loaded.bible, sceneId);
    const transcript = notes.map((note) => `Round ${note.roundNumber}: ${note.text}`).join("\n");
    const known = Object.values(state.ledger).flatMap((entry) => entry.facts.some((fact) => fact.visibility === "public") ? [{ entityId: entry.entityId, canonicalName: entry.canonicalName }] : []);
    const result = await chronicler.chronicle({
      audience: "public",
      language: state.language,
      transcript,
      previousSummary: previous?.text ?? null,
      knownEntities: known,
      scene: { id: scene?.id ?? sceneId, title: scene?.title ?? sceneId },
    });
    if (result.summary.trim().length === 0) throw new Error("Chronicler returned an empty scene memory.");
    const summary = await bus.execute(item.key, { kind: "compactSceneNotes", sceneId: sceneId as SceneId, throughRound, text: result.summary }, { commandId: `${item.id}:scene-notes:${sceneId}`, actor: system });
    if (summary.kind === "rejected") return;
    for (const [index, fact] of result.facts.entries()) {
      await bus.execute(
        item.key,
        { kind: "recordLedgerFact", entityId: fact.entityId, canonicalName: fact.canonicalName, fact: fact.fact, visibility: "public" },
        { commandId: `${item.id}:scene-fact:${sceneId}:${index}`, actor: system },
      );
    }
    await this.chronicle(item, throughRound, true);
  }

  private async judgeSceneNotes(item: OutboxItem, roundNumber: number, sceneId: string): Promise<void> {
    const loaded = await this.load(item.key);
    const { state } = loaded.stored;
    const pending = (state.pendingSceneNotes ?? []).filter((note) => note.roundNumber === roundNumber && note.sceneId === sceneId);
    if (pending.length === 0) return;
    const scene = findScene(loaded.bible, sceneId);
    const notes = pending.map(({ noteIndex, text }) => ({ noteIndex, text }));
    const judge = this.options.noteJudge;
    if (judge === undefined) {
      await this.discardSceneNotes(item, roundNumber, sceneId as SceneId, pending.map((note) => ({ noteIndex: note.noteIndex, decision: "drop" as const, text: "", reason: "Scene note judge unavailable; discarded." })));
      return;
    }
    try {
      if (scene === undefined) throw new Error("The proposed note refers to an unknown scene.");
      const committedOutcomes = renderTranscript({
        audience: "planner", state, events: loaded.events, bible: loaded.bible, glossary: this.glossary(loaded), budgetTokens: this.options.budgetTokens ?? defaultContextBudget,
      }, roundNumber - 1, roundNumber);
      const people = loaded.bible.npcs.filter((npc) => scene.npcIds.includes(npc.id) && state.npcsDown?.includes(npc.id) !== true).map((npc) => ({ id: npc.id, name: npc.name, description: npc.publicDescription, secret: npc.secret }));
      const results = await judge.judge({
        language: state.language,
        scene: { id: scene.id, title: scene.title, publicDescription: scene.publicDescription, ...(scene.details === undefined ? {} : { details: scene.details }), dmNotes: scene.dmNotes },
        adventure: { title: loaded.bible.title, premise: loaded.bible.premise, dmOverview: loaded.bible.dmOverview },
        establishedPeople: people,
        committedOutcomes: committedOutcomes === "" ? [] : [committedOutcomes],
        notes,
      });
      const expected = new Set(pending.map((note) => note.noteIndex));
      const seen = new Set<number>();
      for (const result of results) {
        if (!expected.has(result.noteIndex) || seen.has(result.noteIndex)) throw new Error("Scene note judge returned invalid note indexes.");
        seen.add(result.noteIndex);
      }
      const normalized = pending.map((note) => results.find((result) => result.noteIndex === note.noteIndex) ?? ({ noteIndex: note.noteIndex, decision: "drop" as const, text: "", reason: "Judge returned no decision; discarded." }));
      await this.discardSceneNotes(item, roundNumber, sceneId as SceneId, normalized);
    } catch (error) {
      if (item.attempts + 1 < this.maxAttempts) throw error;
      await this.discardSceneNotes(item, roundNumber, sceneId as SceneId, pending.map((note) => ({ noteIndex: note.noteIndex, decision: "drop" as const, text: "", reason: "Judge failed; discarded." })));
    }
  }

  private async discardSceneNotes(item: OutboxItem, roundNumber: number, sceneId: SceneId, results: readonly { readonly noteIndex: number; readonly decision: "keep" | "reword" | "drop"; readonly text: string; readonly reason: string }[]): Promise<void> {
    const reviewed = await this.options.bus.execute(item.key, { kind: "reviewSceneNotes", roundNumber, sceneId, results }, { commandId: `${item.id}:review`, actor: system });
    if (reviewed.kind === "rejected" && reviewed.rejection.code !== "staleSummary") throw new Error(`Scene note review was rejected: ${reviewed.rejection.code}.`);
  }

  // The opening scene, told before the first round. Like a round's narration,
  // it falls back to a template built from the adventure's own text, so an
  // outage cannot keep the table from starting.
  private async narrateOpening(item: OutboxItem): Promise<void> {
    const loaded = await this.load(item.key);
    const { state } = loaded.stored;
    if (state.opening !== "pending") return;
    const heroes = Object.values(state.members).flatMap((member) => {
      const sheet = member.characterId === null ? undefined : state.characters[member.characterId];
      return sheet === undefined ? [] : [{ name: sheet.name, className: sheet.className ?? null }];
    });
    const request: NarratorRequest = {
      context: this.context("narrator", loaded),
      language: state.language,
      roundNumber: 0,
      outcomes: [],
      spotlight: [],
      threat: null,
      opening: { heroes },
    };
    let text: string;
    try {
      text = (await this.options.narrator.narrate(request)).text;
    } catch (error) {
      if (item.attempts + 1 < this.maxAttempts) throw error;
      text = fallbackOpening(loaded, heroes.map((hero) => hero.name));
    }
    await this.options.bus.execute(item.key, { kind: "recordOpening", text }, { commandId: `${item.id}:opening`, actor: system });
  }

  // Flourishes are optional color: a failed one is skipped, since the table
  // already has the template lines and play has moved on. The closing
  // narration opens the next round, so it falls back to a template instead.
  private async narrateCombat(item: OutboxItem, encounterId: string, round: number, final: boolean): Promise<void> {
    const loaded = await this.load(item.key);
    const encounter = loaded.stored.state.encounter;
    if (encounter?.id !== encounterId || encounter.narratedRound >= round) return;
    const request = this.combatNarratorRequest(loaded, encounterId, round, final);
    let text: string;
    try {
      text = (await this.options.narrator.narrateCombat(request)).text;
    } catch (error) {
      if (!final) return;
      if (item.attempts + 1 < this.maxAttempts) throw error;
      text = fallbackCombatNarration(request);
    }
    await this.options.bus.execute(
      item.key,
      { kind: "recordCombatNarration", encounterId, round, text },
      { commandId: `${item.id}:combat-narration`, actor: system },
    );
  }

  // A settled trade waiting for its Narrator line (engine/shop.ts). Unlike
  // narrateCombat this is never load-bearing for anything else, so a failure
  // that exhausts its attempts just leaves the fallback line — nothing is
  // held or retried past that.
  private async narrateTrade(item: OutboxItem, tradeId: string): Promise<void> {
    const loaded = await this.load(item.key);
    if (loaded.stored.state.trades[tradeId] === undefined) return; // Already narrated, or gone.
    const request = this.tradeNarratorRequest(loaded, tradeId);
    let text: string;
    try {
      text = (await this.options.narrator.narrateTrade(request)).text;
    } catch (error) {
      if (item.attempts + 1 < this.maxAttempts) throw error;
      text = fallbackTradeNarration(request);
    }
    await this.options.bus.execute(item.key, { kind: "recordTradeNarration", tradeId, text }, { commandId: `${item.id}:trade-narration`, actor: system });
  }

  // A settled conversation waiting for its Narrator line (engine/dialogue.ts).
  // Same "not load-bearing" shape as narrateTrade: a failure that exhausts
  // its attempts just leaves the fallback line.
  private async narrateDialogue(item: OutboxItem, dialogueId: string): Promise<boolean> {
    const loaded = await this.load(item.key);
    if (loaded.stored.state.dialogues[dialogueId] === undefined) return true; // Already narrated, or gone.
    const current = loaded.stored.state.dialogues[dialogueId];
    if (current !== undefined && Object.values(loaded.stored.state.dialogues).some((dialogue) => dialogue.npcId === current.npcId && Number(dialogue.id.split(":")[1]) < Number(dialogueId.split(":")[1]))) return false;
    const request = this.dialogueNarratorRequest(loaded, dialogueId);
    let text: string;
    try {
      text = (await this.options.narrator.narrateDialogue(request)).text;
    } catch (error) {
      if (item.attempts + 1 < this.maxAttempts) throw error;
      text = fallbackDialogueNarration(request);
    }
    await this.options.bus.execute(item.key, { kind: "recordDialogueNarration", dialogueId, text }, { commandId: `${item.id}:dialogue-narration`, actor: system });
    return true;
  }

  // A ritual spell cast outside combat, waiting on its Narrator line
  // (engine/utility-magic.ts). Same "not load-bearing" shape as narrateTrade
  // and narrateDialogue.
  private async narrateUtilityCast(item: OutboxItem, castId: string): Promise<void> {
    const loaded = await this.load(item.key);
    if (loaded.stored.state.utilityCasts[castId] === undefined) return; // Already narrated, or gone.
    const request = this.utilityCastNarratorRequest(loaded, castId);
    let text: string;
    try {
      text = (await this.options.narrator.narrateUtilityCast(request)).text;
    } catch (error) {
      if (item.attempts + 1 < this.maxAttempts) throw error;
      text = fallbackUtilityCastNarration(request);
    }
    await this.options.bus.execute(item.key, { kind: "recordUtilityCastNarration", castId, text }, { commandId: `${item.id}:utility-cast-narration`, actor: system });
  }

  // A settled travel or environmental hazard, waiting on its Narrator line
  // (engine/travel.ts). Same "not load-bearing" shape as the other outside-combat narrations.
  private async narrateHazard(item: OutboxItem, hazardId: string): Promise<void> {
    const loaded = await this.load(item.key);
    if (loaded.stored.state.hazards[hazardId] === undefined) return; // Already narrated, or gone.
    const request = this.hazardNarratorRequest(loaded, hazardId);
    let text: string;
    try {
      text = (await this.options.narrator.narrateHazard(request)).text;
    } catch (error) {
      if (item.attempts + 1 < this.maxAttempts) throw error;
      text = fallbackHazardNarration(request);
    }
    await this.options.bus.execute(item.key, { kind: "recordHazardNarration", hazardId, text }, { commandId: `${item.id}:hazard-narration`, actor: system });
  }

  private combatNarratorRequest(loaded: Loaded, encounterId: string, round: number, final: boolean): CombatNarratorRequest {
    const { state } = loaded.stored;
    const record = encounterRecords(loaded.events, { state, bible: loaded.bible, glossary: this.glossary(loaded) }).findLast(
      (candidate) => candidate.id === encounterId,
    );
    // The closing narration covers every round not yet described.
    const rounds = (record?.rounds ?? []).filter((candidate) =>
      final ? candidate.round > (state.encounter?.narratedRound ?? 0) : candidate.round === round,
    );
    return {
      context: this.context("narrator", loaded),
      language: state.language,
      encounterId,
      round,
      final,
      beats: rounds.flatMap((candidate) => candidate.beats),
      outcome: final ? (record?.outcome ?? null) : null,
    };
  }

  private tradeNarratorRequest(loaded: Loaded, tradeId: string): TradeNarratorRequest {
    const { state } = loaded.stored;
    const trade = state.trades[tradeId];
    if (trade === undefined) throw new Error(`Unknown trade ${tradeId}.`);
    const npc = loaded.bible.npcs.find((candidate) => candidate.id === trade.npcId);
    const glossary = this.glossary(loaded);
    return {
      context: this.context("narrator", loaded),
      language: state.language,
      npc: { id: trade.npcId, name: npc?.name ?? trade.npcId, voice: npc?.voice ?? "" },
      heroName: state.characters[trade.characterId]?.name ?? trade.characterId,
      itemName: glossary.names[trade.itemId] ?? trade.itemId,
      direction: trade.direction,
      completed: trade.outcome === "completed",
      listedPrice: trade.listedPrice,
      finalPrice: trade.finalPrice,
      haggle:
        trade.haggle === null
          ? null
          : { skill: checkLabel(trade.haggle.test), total: trade.haggle.total, dc: trade.haggle.dc, success: trade.haggle.success, headline: trade.haggle.moments.headline },
    };
  }

  private dialogueNarratorRequest(loaded: Loaded, dialogueId: string): DialogueNarratorRequest {
    const { state } = loaded.stored;
    const dialogue = state.dialogues[dialogueId];
    if (dialogue === undefined) throw new Error(`Unknown dialogue ${dialogueId}.`);
    const npc = loaded.bible.npcs.find((candidate) => candidate.id === dialogue.npcId);
    const secretRevealed = state.npcSecretsRevealed?.[dialogue.npcId] === true;
    return {
      context: this.context("narrator", loaded),
      language: state.language,
      npc: {
        id: dialogue.npcId,
        name: npc?.name ?? dialogue.npcId,
        voice: npc?.voice ?? "",
        publicDescription: npc?.publicDescription ?? "",
        secret: secretRevealed ? (npc?.secret ?? null) : null,
      },
      heroName: state.characters[dialogue.characterId]?.name ?? dialogue.characterId,
      kind: dialogue.kind,
      question: dialogue.question,
      press:
        dialogue.check === null
          ? null
          : { skill: checkLabel(dialogue.check.test), total: dialogue.check.total, dc: dialogue.check.dc, success: dialogue.check.success, headline: dialogue.check.moments.headline },
      secretRevealed,
    };
  }

  private utilityCastNarratorRequest(loaded: Loaded, castId: string): UtilityCastNarratorRequest {
    const { state } = loaded.stored;
    const cast = state.utilityCasts[castId];
    if (cast === undefined) throw new Error(`Unknown utility cast ${castId}.`);
    const glossary = this.glossary(loaded);
    return {
      context: this.context("narrator", loaded),
      language: state.language,
      heroName: state.characters[cast.characterId]?.name ?? cast.characterId,
      spell: { id: cast.spellId, name: glossary.names[cast.spellId] ?? cast.spellId },
    };
  }

  private hazardNarratorRequest(loaded: Loaded, hazardId: string): HazardNarratorRequest {
    const { state } = loaded.stored;
    const hazard = state.hazards[hazardId];
    if (hazard === undefined) throw new Error(`Unknown hazard ${hazardId}.`);
    return {
      context: this.context("narrator", loaded),
      language: state.language,
      heroName: state.characters[hazard.characterId]?.name ?? hazard.characterId,
      ability: checkLabel({ kind: "ability", ability: hazard.ability }),
      dc: hazard.dc,
      total: hazard.total,
      success: hazard.success,
      headline: hazard.moments.headline,
      exhaustionGained: hazard.exhaustionGained,
    };
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
    const threat = findEncounter(loaded.bible, state.pendingEncounter?.id ?? null)?.publicDescription ?? null;
    return { context: this.context("narrator", loaded), language: state.language, roundNumber, outcomes, spotlight, threat };
  }

  private glossary(loaded: Loaded): Glossary {
    const glossary = this.options.glossaries[loaded.stored.state.language];
    if (glossary === undefined) throw new Error(`No glossary for ${loaded.stored.state.language}.`);
    return glossary;
  }

  private context(audience: ContextAudience, loaded: Loaded): DmContext {
    const glossary = this.glossary(loaded);
    return assembleContext({
      audience,
      state: loaded.stored.state,
      events: loaded.events,
      bible: loaded.bible,
      glossary,
      ...(this.options.rulesets === undefined ? {} : { content: this.options.rulesets.resolve(loaded.stored.ruleset).content }),
      budgetTokens: this.options.budgetTokens ?? defaultContextBudget,
    });
  }

  private async load(key: CampaignKey): Promise<Loaded> {
    const { stored, envelopes } = await this.options.unitOfWork.transaction(async (tx) => ({
      stored: await tx.loadCampaign(key),
      envelopes: await tx.readEvents(key),
    }));
    if (stored === undefined) throw new Error(`Campaign ${key.campaignId} not found.`);
    const bible = this.options.adventures.find(stored.adventure.adventureId, stored.adventure.version, stored.state.language);
    if (bible === undefined) throw new Error(`Adventure ${stored.adventure.adventureId}@${stored.adventure.version} not found.`);
    return { stored, events: envelopes.map((envelope) => envelope.event), bible };
  }
}

interface Loaded {
  readonly stored: StoredCampaign;
  readonly events: readonly CampaignEvent[];
  readonly bible: NonNullable<ReturnType<AdventureCatalog["find"]>>;
}

function fallbackOpening(loaded: Loaded, heroNames: readonly string[]): string {
  const zh = loaded.stored.state.language === "zh-TW";
  const scene = findScene(loaded.bible, loaded.stored.state.sceneId);
  const party = heroNames.join(zh ? "、" : ", ");
  const lines = [loaded.bible.premise, scene?.publicDescription ?? ""].filter((line) => line.trim() !== "");
  lines.push(zh ? `${party} 來到這裡。你們要怎麼做？` : `${party} arrive here together. What do you do?`);
  return lines.join("\n\n");
}

function fallbackCombatNarration(request: CombatNarratorRequest): string {
  const zh = request.language === "zh-TW";
  if (request.outcome === "victory") return zh ? "戰鬥結束，敵人已被擊退。" : "The fight is over; the enemy is beaten.";
  if (request.outcome === "defeat") return zh ? "戰鬥結束，隊伍倒下了。" : "The fight is over; the party has fallen.";
  return zh ? "戰鬥結束。" : "The fight is over.";
}

function fallbackTradeNarration(request: TradeNarratorRequest): string {
  const zh = request.language === "zh-TW";
  if (!request.completed) return zh ? `${request.npc.name}搖頭表示還不夠。` : `${request.npc.name} shakes their head — it's not enough.`;
  const verb = request.direction === "buy" ? (zh ? "賣給" : "sells to") : zh ? "買下" : "buys from";
  return zh
    ? `${request.npc.name}${verb}${request.heroName} ${request.itemName}，收取 ${request.finalPrice} 枚金幣。`
    : `${request.npc.name} ${verb} ${request.heroName} the ${request.itemName} for ${request.finalPrice} gold.`;
}

function fallbackDialogueNarration(request: DialogueNarratorRequest): string {
  const zh = request.language === "zh-TW";
  if (request.kind === "ask") return zh ? `${request.npc.name}回答了你的問題。` : `${request.npc.name} answers your question.`;
  return request.secretRevealed
    ? zh
      ? `${request.npc.name}終於鬆口了。`
      : `${request.npc.name} finally gives in.`
    : zh
      ? `${request.npc.name}不為所動，什麼都沒說。`
      : `${request.npc.name} holds firm and says nothing more.`;
}

function fallbackUtilityCastNarration(request: UtilityCastNarratorRequest): string {
  const zh = request.language === "zh-TW";
  return zh ? `${request.heroName}施展了${request.spell.name}。` : `${request.heroName} casts ${request.spell.name}.`;
}

function fallbackHazardNarration(request: HazardNarratorRequest): string {
  const zh = request.language === "zh-TW";
  return request.success
    ? zh
      ? `${request.heroName}挺過了這段艱苦的路程。`
      : `${request.heroName} pushes through the ordeal unscathed.`
    : zh
      ? `${request.heroName}被這段路程磨得筋疲力盡。`
      : `${request.heroName} is worn down by the ordeal.`;
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
