import type { CampaignLanguage } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { Actor, CampaignCommand } from "../../../domain/campaign/commands/campaign-command.js";
import type { CharacterSheet } from "../../../domain/campaign/character/character-sheet.js";
import type { UserId } from "../../../domain/campaign/core/ids.js";
import type { RandomSource } from "../../../domain/campaign/dice/random-source.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import type { CampaignState, MemberState, Pacing } from "../../../domain/campaign/state/campaign-state.js";
import type { AdventureDocument } from "../adventures/adventure-document.js";
import { CampaignCommandBus } from "../campaign-command-bus.js";
import type { CampaignKey, CampaignUnitOfWork, EventEnvelope, StoredCampaign } from "../ports/campaign-store.js";
import type { ModelCallObserver } from "../dm/llm-dm.js";
import type { CampaignNarrator, CampaignPlanner, NarratorRequest, PlannerRequest } from "../ports/dm-ports.js";
import type { ModelUsage } from "../ports/structured-model-client.js";
import type { RulesetCatalog } from "../rules/ruleset-catalog.js";
import { ManualClock } from "../time/manual-clock.js";
import { DmJobWorker } from "../workers/dm-job-worker.js";
import { RollWorker } from "../workers/roll-worker.js";
import { TimerWorker } from "../workers/timer-worker.js";

// What a scripted player does in a given round.
export type HarnessMove = { readonly kind: "act"; readonly text: string } | { readonly kind: "pass" } | { readonly kind: "silent" };

export interface HarnessPlayer {
  readonly userId: UserId;
  readonly heroId: string;
  readonly persona: string;
  move(roundNumber: number, language: CampaignLanguage): HarnessMove;
  // Clicks Roll on their checks; otherwise the roll timer auto-rolls.
  readonly clicksRoll: boolean;
  // Comes back the round after being marked away.
  readonly returnsWhenAway: boolean;
}

export interface HarnessOptions {
  readonly adventure: AdventureDocument;
  readonly players: readonly HarnessPlayer[];
  // Builds the DM for this run. Model-backed DMs report each call to
  // `observe` so the report can include tokens and models.
  readonly dm: (observe: ModelCallObserver) => { readonly planner: CampaignPlanner; readonly narrator: CampaignNarrator };
  readonly random: RandomSource;
  readonly rulesets: RulesetCatalog;
  readonly rulesetPin: StoredCampaign["ruleset"];
  readonly glossary: Glossary;
  readonly unitOfWork: CampaignUnitOfWork;
  readonly rounds: number;
  readonly pacing?: Pacing;
  // Wall clock for latency measurement; defaults to performance.now.
  readonly measure?: () => number;
}

export interface ModelCall {
  readonly call: "planner" | "narrator";
  readonly roundNumber: number;
  readonly milliseconds: number;
  readonly contextTokens: number;
  readonly failed: boolean;
  readonly model: string | null;
  readonly promptVersion: string | null;
  readonly usage: ModelUsage | null;
}

export interface HarnessRun {
  readonly language: CampaignLanguage;
  readonly adventure: AdventureDocument;
  readonly players: readonly HarnessPlayer[];
  readonly finalState: CampaignState;
  readonly events: readonly EventEnvelope[];
  readonly calls: readonly ModelCall[];
  readonly narratorRequests: readonly NarratorRequest[];
  readonly stoppedBecause: "roundLimit" | "waitingForPlayers" | "stalled";
}

const harnessPacing: Pacing = { roundSeconds: 300, rollSeconds: 120, turnSeconds: 180, awayAfterMisses: 2 };
const campaignKey: CampaignKey = { guildId: "harness", campaignId: "harness-campaign" };
const system: Actor = { kind: "system" };

// Plays a campaign end to end without Discord, through the real engine,
// command bus, and workers (plan §12, Harness). Everything outside the
// process is a port: model calls, dice, clock, and storage.
export async function runHarness(options: HarnessOptions): Promise<HarnessRun> {
  const { adventure, players, unitOfWork } = options;
  const pacing = options.pacing ?? harnessPacing;
  const clock = new ManualClock(Date.UTC(2026, 0, 1));
  const measure = options.measure ?? ((): number => performance.now());
  const calls: ModelCall[] = [];
  let lastObserved: Parameters<ModelCallObserver>[0] | null = null;
  const dmParts = options.dm((observed) => {
    lastObserved = observed;
  });
  const record = (entry: Pick<ModelCall, "call" | "roundNumber" | "milliseconds" | "contextTokens" | "failed">): void => {
    const observed = lastObserved;
    lastObserved = null;
    calls.push({ ...entry, model: observed?.model ?? null, promptVersion: observed?.promptVersion ?? null, usage: observed?.usage ?? null });
  };
  const narratorRequests: NarratorRequest[] = [];
  const bus = new CampaignCommandBus({ unitOfWork, rulesets: options.rulesets, clock });

  const planner: CampaignPlanner = {
    plan: (request: PlannerRequest) => timed(record, measure, "planner", request.roundNumber, request.context.estimatedTokens, () => dmParts.planner.plan(request)),
  };
  const narrator: CampaignNarrator = {
    narrate: (request: NarratorRequest) => {
      narratorRequests.push(request);
      return timed(record, measure, "narrator", request.roundNumber, request.context.estimatedTokens, () => dmParts.narrator.narrate(request));
    },
  };
  const dm = new DmJobWorker({
    unitOfWork,
    bus,
    planner,
    narrator,
    adventures: { find: (): AdventureDocument["bible"] => adventure.bible },
    glossaries: { [adventure.bible.language]: options.glossary },
  });
  const rolls = new RollWorker(unitOfWork, bus, options.random, clock);
  const timers = new TimerWorker(unitOfWork, bus, clock);

  await unitOfWork.transaction((tx) =>
    tx.createCampaign(campaignKey, {
      state: initialState(options, pacing),
      revision: 0,
      ruleset: options.rulesetPin,
      adventure: { adventureId: adventure.bible.id, version: adventure.bible.version },
    }),
  );

  let commandNumber = 0;
  const execute = async (command: CampaignCommand, actor: Actor): Promise<void> => {
    commandNumber += 1;
    await bus.execute(campaignKey, command, { commandId: `harness-${commandNumber}`, actor });
  };
  const load = async (): Promise<CampaignState> => {
    const stored = await unitOfWork.transaction((tx) => tx.loadCampaign(campaignKey));
    if (stored === undefined) throw new Error("The harness campaign disappeared.");
    return stored.state;
  };
  const drainDm = async (): Promise<void> => {
    // A failed call stays pending with a bounded retry count; keep running
    // until the job completes or gives up.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await dm.runOnce();
      if (result.failed.length === 0) return;
    }
  };

  let stoppedBecause: HarnessRun["stoppedBecause"] = "roundLimit";
  await execute({ kind: "openRound" }, system);
  for (let played = 0; played < options.rounds; played += 1) {
    let state = await load();
    for (const player of players) {
      if (player.returnsWhenAway && state.members[player.userId]?.availability === "away") {
        await execute({ kind: "markReturned", userId: player.userId }, user(player));
      }
    }
    state = await load();
    if (state.status === "waitingForPlayers") {
      const present = players.find((player) => state.members[player.userId]?.availability === "present");
      if (present === undefined) {
        stoppedBecause = "waitingForPlayers";
        break;
      }
      await execute({ kind: "continue" }, user(present));
      state = await load();
    }
    if (state.round === null) {
      const present = players.find((player) => state.members[player.userId]?.availability === "present");
      if (present !== undefined) await execute({ kind: "openRound" }, user(present));
      state = await load();
    }
    const round = state.round;
    if (round === null) {
      stoppedBecause = "stalled";
      break;
    }

    for (const player of players) {
      if (!round.participants.includes(player.heroId)) continue;
      const move = player.move(round.number, adventure.bible.language);
      if (move.kind === "act") await execute({ kind: "submitAction", characterId: player.heroId, text: move.text }, user(player));
      if (move.kind === "pass") await execute({ kind: "pass", characterId: player.heroId }, user(player));
    }
    if ((await load()).round?.status === "collecting") {
      clock.advance((pacing.roundSeconds ?? 0) * 1000);
      await timers.runOnce();
      if ((await load()).round?.status === "collecting") await execute({ kind: "closeRound" }, user(players[0]));
    }

    await drainDm();
    for (const check of Object.values((await load()).checks)) {
      const owner = players.find((player) => player.heroId === check.characterId);
      if (check.status === "pending" && owner?.clicksRoll === true) {
        await execute({ kind: "requestRoll", checkId: check.id }, user(owner));
      }
    }
    if (Object.values((await load()).checks).some((check) => check.status === "pending")) {
      clock.advance((pacing.rollSeconds ?? 0) * 1000);
      await timers.runOnce();
    }
    await rolls.runOnce();
    await drainDm();
    clock.advance(30_000);
  }

  const events = await unitOfWork.transaction((tx) => tx.readEvents(campaignKey));
  return {
    language: adventure.bible.language,
    adventure,
    players,
    finalState: await load(),
    events,
    calls,
    narratorRequests,
    stoppedBecause,
  };
}

function user(player: HarnessPlayer | undefined): Actor {
  if (player === undefined) throw new Error("The harness needs at least one player.");
  return { kind: "user", userId: player.userId };
}

function initialState(options: HarnessOptions, pacing: Pacing): CampaignState {
  const { adventure, players } = options;
  const members: Record<UserId, MemberState> = {};
  const characters: Record<string, CharacterSheet> = {};
  for (const player of players) {
    const hero = adventure.heroes.find((candidate) => candidate.id === player.heroId);
    if (hero === undefined) throw new Error(`The adventure has no hero ${player.heroId}.`);
    const { class: _class, ...sheet } = hero;
    characters[hero.id] = { ...sheet, ownerUserId: player.userId };
    members[player.userId] = { userId: player.userId, characterId: hero.id, availability: "present", consecutiveMisses: 0 };
  }
  const organizer = players[0];
  if (organizer === undefined) throw new Error("The harness needs at least one player.");
  return {
    campaignId: campaignKey.campaignId,
    organizerId: organizer.userId,
    status: "active",
    language: adventure.bible.language,
    pacing,
    sceneId: adventure.bible.startScene,
    members,
    characters,
    round: null,
    lastRoundNumber: 0,
    lastNarratedRound: 0,
    checks: {},
    ledger: {},
    encounter: null,
    heroStatus: {},
  };
}

async function timed<T>(
  record: (entry: Pick<ModelCall, "call" | "roundNumber" | "milliseconds" | "contextTokens" | "failed">) => void,
  measure: () => number,
  call: ModelCall["call"],
  roundNumber: number,
  contextTokens: number,
  work: () => Promise<T>,
): Promise<T> {
  const started = measure();
  try {
    const result = await work();
    record({ call, roundNumber, milliseconds: measure() - started, contextTokens, failed: false });
    return result;
  } catch (error) {
    record({ call, roundNumber, milliseconds: measure() - started, contextTokens, failed: true });
    throw error;
  }
}
