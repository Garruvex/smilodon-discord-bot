import type { CampaignLanguage } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { Actor, CampaignCommand } from "../../../domain/campaign/commands/campaign-command.js";
import { currentCombatant } from "../../../domain/campaign/combat/combat-state.js";
import type { UserId } from "../../../domain/campaign/core/ids.js";
import type { RandomSource } from "../../../domain/campaign/dice/random-source.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import type { CampaignState, Pacing } from "../../../domain/campaign/state/campaign-state.js";
import { AdventureDocumentError, checkAdventureContent, type AdventureDocument } from "../adventures/adventure-document.js";
import { CampaignCommandBus } from "../campaign-command-bus.js";
import type { CampaignKey, CampaignUnitOfWork, CommandOutcome, EventEnvelope, StoredCampaign } from "../ports/campaign-store.js";
import type { ModelCallKind, ModelCallObserver } from "../dm/llm-dm.js";
import type { CampaignNarrator, CampaignPlanner, CombatNarratorRequest, NarratorRequest, PlannerRequest } from "../ports/dm-ports.js";
import type { ModelUsage } from "../ports/structured-model-client.js";
import type { RulesetCatalog } from "../rules/ruleset-catalog.js";
import { ManualClock } from "../time/manual-clock.js";
import { buildStartingState } from "../setup/starting-state.js";
import { DmJobWorker } from "../workers/dm-job-worker.js";
import { RollWorker } from "../workers/roll-worker.js";
import { TimerWorker } from "../workers/timer-worker.js";
import { chooseHeroCommand, type HarnessCombatRole } from "./harness-tactics.js";

// What a scripted player does in a given round.
export type HarnessMove = { readonly kind: "act"; readonly text: string } | { readonly kind: "pass" } | { readonly kind: "silent" };

// What a player can see when choosing an action.
export interface RoundView {
  readonly heroName: string;
  readonly sceneTitle: string;
  // The latest public narration, if any.
  readonly narration: string | null;
}

export interface HarnessPlayer {
  readonly userId: UserId;
  readonly heroId: string;
  readonly persona: string;
  move(roundNumber: number, language: CampaignLanguage, view: RoundView): HarnessMove | Promise<HarnessMove>;
  // Clicks Roll on their checks; otherwise the roll timer auto-rolls.
  readonly clicksRoll: boolean;
  // Comes back the round after being marked away.
  readonly returnsWhenAway: boolean;
  readonly combatRole: HarnessCombatRole;
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
  readonly call: ModelCallKind;
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
  readonly combatNarratorRequests: readonly CombatNarratorRequest[];
  readonly glossary: Glossary;
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
  const contentProblems = checkAdventureContent(adventure, options.rulesets.resolve(options.rulesetPin).content);
  if (contentProblems.length > 0) throw new AdventureDocumentError(contentProblems);
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
  const combatNarratorRequests: CombatNarratorRequest[] = [];
  const bus = new CampaignCommandBus({ unitOfWork, rulesets: options.rulesets, clock });

  const planner: CampaignPlanner = {
    plan: (request: PlannerRequest) => timed(record, measure, "planner", request.roundNumber, request.context.estimatedTokens, () => dmParts.planner.plan(request)),
  };
  const narrator: CampaignNarrator = {
    narrate: (request: NarratorRequest) => {
      narratorRequests.push(request);
      return timed(record, measure, "narrator", request.roundNumber, request.context.estimatedTokens, () => dmParts.narrator.narrate(request));
    },
    narrateCombat: (request: CombatNarratorRequest) => {
      combatNarratorRequests.push(request);
      return timed(record, measure, "flourish", request.round, request.context.estimatedTokens, () => dmParts.narrator.narrateCombat(request));
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
  const execute = async (command: CampaignCommand, actor: Actor): Promise<CommandOutcome> => {
    commandNumber += 1;
    return bus.execute(campaignKey, command, { commandId: `harness-${commandNumber}`, actor });
  };
  const load = async (): Promise<CampaignState> => {
    const stored = await unitOfWork.transaction((tx) => tx.loadCampaign(campaignKey));
    if (stored === undefined) throw new Error("The harness campaign disappeared.");
    return stored.state;
  };
  // A player whose hero died takes a fresh copy of their preset (no loot), as a
  // new hero at the party's level; the harness then plays the new one.
  const heroes = new Map<UserId, string>(players.map((player) => [player.userId, player.heroId]));
  const heroOf = (player: HarnessPlayer): string => heroes.get(player.userId) ?? player.heroId;
  let replacements = 0;
  const replaceFallenHeroes = async (state: CampaignState): Promise<void> => {
    for (const player of players) {
      const preset = adventure.heroes.find((candidate) => candidate.id === player.heroId);
      if (preset === undefined || state.heroStatus[heroOf(player)]?.dead !== true) continue;
      const { class: _class, ...sheet } = preset;
      replacements += 1;
      const id = `${preset.id}-${replacements + 1}`;
      const outcome = await execute({ kind: "joinHero", sheet: { ...sheet, id, ownerUserId: player.userId, name: `${preset.name} II` } }, user(player));
      if (outcome.kind !== "rejected") heroes.set(player.userId, id);
    }
  };
  const viewFor = async (player: HarnessPlayer, state: CampaignState): Promise<RoundView> => {
    const log = await unitOfWork.transaction((tx) => tx.readEvents(campaignKey));
    const narration = log.map((envelope) => envelope.event).findLast((event) => event.kind === "narrationRecorded");
    return {
      heroName: state.characters[heroOf(player)]?.name ?? heroOf(player),
      sceneTitle: adventure.bible.scenes.find((scene) => scene.id === state.sceneId)?.title ?? "",
      narration: narration?.kind === "narrationRecorded" ? narration.text : null,
    };
  };
  const drainDm = async (): Promise<void> => {
    // A failed call stays pending with a bounded retry count; keep running
    // until the job completes or gives up.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await dm.runOnce();
      if (result.failed.length === 0) return;
    }
  };

  // Rolls can chain (a hit asks for damage), so run until none are left.
  const drainRolls = async (): Promise<void> => {
    for (let pass = 0; pass < 50; pass += 1) {
      if ((await rolls.runOnce()).processed === 0) return;
    }
  };
  // Plays a fight to its end: players take their turns through real
  // commands; monsters and away heroes are played by the engine. A player
  // command the engine refuses ends that turn, as a confused player would.
  const runCombat = async (): Promise<boolean> => {
    for (let step = 0; step < 600; step += 1) {
      await drainRolls();
      await drainDm();
      const state = await load();
      const encounter = state.encounter;
      if (encounter === null || encounter.status === "ended") return true;
      if (state.status !== "active" || encounter.status !== "active") return false;
      const hero = currentCombatant(encounter);
      const player = players.find((candidate) => heroOf(candidate) === hero?.id);
      if (hero === undefined || player === undefined || state.members[player.userId]?.availability !== "present") return false;
      const command = chooseHeroCommand(encounter, hero, player.combatRole);
      const outcome = await execute(command, user(player));
      if (outcome.kind === "rejected" && command.kind !== "endTurn") await execute({ kind: "endTurn", combatantId: hero.id }, user(player));
    }
    return false;
  };

  let stoppedBecause: HarnessRun["stoppedBecause"] = "roundLimit";
  await execute({ kind: "openRound" }, system);
  for (let played = 0; played < options.rounds; played += 1) {
    let state = await load();
    await replaceFallenHeroes(state);
    state = await load();
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
      if (!round.participants.includes(heroOf(player))) continue;
      const move = await player.move(round.number, adventure.bible.language, await viewFor(player, state));
      if (move.kind === "act") await execute({ kind: "submitAction", characterId: heroOf(player), text: move.text }, user(player));
      if (move.kind === "pass") await execute({ kind: "pass", characterId: heroOf(player) }, user(player));
    }
    if ((await load()).round?.status === "collecting") {
      clock.advance((pacing.roundSeconds ?? 0) * 1000);
      await timers.runOnce();
      if ((await load()).round?.status === "collecting") await execute({ kind: "closeRound" }, user(players[0]));
    }

    await drainDm();
    for (const check of Object.values((await load()).checks)) {
      const owner = players.find((player) => heroOf(player) === check.characterId);
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
    const fight = (await load()).encounter;
    if (fight !== null && fight.status !== "ended" && !(await runCombat())) {
      stoppedBecause = "stalled";
      break;
    }
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
    combatNarratorRequests,
    glossary: options.glossary,
    stoppedBecause,
  };
}

function user(player: HarnessPlayer | undefined): Actor {
  if (player === undefined) throw new Error("The harness needs at least one player.");
  return { kind: "user", userId: player.userId };
}

function initialState(options: HarnessOptions, pacing: Pacing): CampaignState {
  const organizer = options.players[0];
  if (organizer === undefined) throw new Error("The harness needs at least one player.");
  return buildStartingState({
    campaignId: campaignKey.campaignId,
    organizerId: organizer.userId,
    adventure: options.adventure,
    seats: options.players.map((player) => ({ userId: player.userId, heroId: player.heroId })),
    pacing,
  });
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
