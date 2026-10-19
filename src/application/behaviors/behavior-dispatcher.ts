import { performance } from "node:perf_hooks";
import { BehaviorResult, BehaviorEvent, type BehaviorContextMap } from "./behavior.js";
import type { BehaviorRegistry } from "./behavior-registry.js";
import { diagnosticElapsed, emitChatDiagnostic, safeFailure, withDiagnosticScope, type DiagnosticLogger, type DiagnosticScopeInput } from "../diagnostics/chat-diagnostics.js";

function sourceScope<TEvent extends BehaviorEvent>(event: TEvent, context: BehaviorContextMap[TEvent]): DiagnosticScopeInput {
  if (event === BehaviorEvent.MessageCreated) {
    const message = context as BehaviorContextMap[BehaviorEvent.MessageCreated];
    return { operation: "dispatch", guildId: message.guildId ?? undefined, channelId: message.channelId, sourceMessageId: message.id };
  }
  if (event === BehaviorEvent.ReactionAdded) {
    const { reaction } = context as BehaviorContextMap[BehaviorEvent.ReactionAdded];
    return { operation: "dispatch", guildId: reaction.message.guildId ?? undefined, channelId: reaction.message.channelId, sourceMessageId: reaction.message.id };
  }
  return { operation: "dispatch" };
}

export class BehaviorDispatcher {
  public constructor(private readonly registry: BehaviorRegistry, private readonly logger: DiagnosticLogger | null = null) {}

  public async dispatch<TEvent extends BehaviorEvent>(
    event: TEvent,
    context: BehaviorContextMap[TEvent],
  ): Promise<BehaviorResult> {
    return withDiagnosticScope(sourceScope(event, context), async () => {
      const started = performance.now();
      emitChatDiagnostic(this.logger, { event: "chat.ingress.received", kind: event });
      const behaviors = this.registry.findByEvent(event);
      let finalResult = BehaviorResult.Continue;
      let behaviorId: string | undefined;
      let stage: "matches" | "execute" = "matches";
      try {
        for (const behavior of behaviors) {
          behaviorId = behavior.id;
          stage = "matches";
          if (!(await behavior.matches(context))) continue;
          emitChatDiagnostic(this.logger, { event: "chat.route.matched", behaviorId });
          stage = "execute";
          const result = await behavior.execute(context);
          if (result === BehaviorResult.StopPropagation) {
            emitChatDiagnostic(this.logger, { event: "chat.dispatch.completed", result, behaviorId, stage, durationMs: diagnosticElapsed(started) });
            return result;
          }
          if (result === BehaviorResult.Handled) finalResult = result;
        }
        emitChatDiagnostic(this.logger, { event: "chat.dispatch.completed", result: finalResult, durationMs: diagnosticElapsed(started) });
        return finalResult;
      } catch (error) {
        emitChatDiagnostic(this.logger, { event: "chat.dispatch.completed", result: "failed", ...(behaviorId ? { behaviorId } : {}), stage, durationMs: diagnosticElapsed(started), ...safeFailure(error, "operation_error") });
        throw error;
      }
    });
  }
}
