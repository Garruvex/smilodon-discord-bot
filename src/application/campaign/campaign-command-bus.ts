import type { Actor, CampaignCommand } from "../../domain/campaign/commands/campaign-command.js";
import { decide } from "../../domain/campaign/engine/decide.js";
import type { EngineRequest } from "../../domain/campaign/engine/engine-request.js";
import { replay } from "../../domain/campaign/events/evolve.js";
import { KeyedSerialQueue } from "../concurrency/keyed-serial-queue.js";
import {
  RevisionConflictError,
  type CampaignKey,
  type CampaignTransaction,
  type CampaignUnitOfWork,
  type CommandOutcome,
} from "./ports/campaign-store.js";
import type { Clock } from "./ports/clock.js";
import { pinKey, type RulesetCatalog } from "./rules/ruleset-catalog.js";

export interface CommandMeta {
  // Idempotency key: the interaction ID, timer ID, or job ID. Running the
  // same command ID twice returns the first outcome and changes nothing.
  readonly commandId: string;
  readonly actor: Actor;
}

export interface CampaignCommandBusOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly rulesets: RulesetCatalog;
  readonly clock: Clock;
  // Called after a commit that queued work, so workers can run promptly
  // instead of waiting for their next poll.
  readonly onWorkQueued?: (key: CampaignKey) => void;
}

// The single write path (code structure §5). Every state change, from a
// button, a timer, a worker, or the organizer, goes through execute().
export class CampaignCommandBus {
  private readonly queue = new KeyedSerialQueue();

  public constructor(private readonly options: CampaignCommandBusOptions) {}

  public async execute(key: CampaignKey, command: CampaignCommand, meta: CommandMeta): Promise<CommandOutcome> {
    return this.queue.run(`${key.guildId}:${key.campaignId}`, async () => {
      try {
        return await this.attempt(key, command, meta);
      } catch (error) {
        // Another process moved the campaign on between load and save:
        // decide again once against the newer state.
        if (!(error instanceof RevisionConflictError)) throw error;
        return this.attempt(key, command, meta);
      }
    });
  }

  private async attempt(key: CampaignKey, command: CampaignCommand, meta: CommandMeta): Promise<CommandOutcome> {
    const { outcome, queuedWork } = await this.options.unitOfWork.transaction(async (tx) => {
      const previous = await tx.findProcessedCommand(key, meta.commandId);
      if (previous !== undefined) return { outcome: previous, queuedWork: false };

      const stored = await tx.loadCampaign(key);
      if (stored === undefined) return { outcome: { kind: "notFound" } as const, queuedWork: false };

      const now = this.options.clock.now();
      const result = decide(stored.state, command, {
        rules: this.options.rulesets.resolve(stored.ruleset),
        now,
        actor: meta.actor,
      });
      // Rejections are not recorded: they change nothing, and the same
      // command may be valid once the state moves on.
      if (result.kind === "rejected") return { outcome: result, queuedWork: false };

      const revision = await tx.saveCampaign(key, replay(stored.state, result.events), stored.revision);
      const rulesRevision = pinKey(stored.ruleset.rulesetId, stored.ruleset.rulesetVersion);
      await tx.appendEvents(
        key,
        result.events.map((event) => ({
          campaignId: key.campaignId,
          causationId: meta.commandId,
          commandKind: command.kind,
          actor: meta.actor,
          rulesRevision,
          recordedAt: now,
          event,
        })),
      );
      await writeRequests(tx, key, meta.commandId, result.requests, now);
      const accepted: CommandOutcome = { kind: "accepted", revision, eventCount: result.events.length };
      await tx.recordProcessedCommand(key, meta.commandId, accepted);
      return { outcome: accepted, queuedWork: result.requests.length > 0 };
    });
    if (queuedWork) this.options.onWorkQueued?.(key);
    return outcome;
  }
}

async function writeRequests(
  tx: CampaignTransaction,
  key: CampaignKey,
  commandId: string,
  requests: readonly EngineRequest[],
  now: number,
): Promise<void> {
  for (const [index, request] of requests.entries()) {
    switch (request.kind) {
      case "startTimer":
        await tx.scheduleTimer(key, request.timer);
        break;
      case "cancelTimer":
        await tx.cancelTimer(key, request.timerId);
        break;
      default:
        await tx.enqueue(key, `${key.guildId}:${key.campaignId}:${commandId}#${index}`, request, now);
    }
  }
}
