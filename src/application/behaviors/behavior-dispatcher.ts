import { BehaviorResult, type BehaviorEvent, type BotBehavior } from "./behavior.js";
import type { BehaviorRegistry } from "./behavior-registry.js";

export class BehaviorDispatcher {
  public constructor(private readonly registry: BehaviorRegistry) {}

  public async dispatch<TContext>(
    event: BehaviorEvent,
    context: TContext,
  ): Promise<BehaviorResult> {
    const behaviors = this.registry.findByEvent(event) as readonly BotBehavior<TContext>[];
    let finalResult = BehaviorResult.Continue;

    for (const behavior of behaviors) {
      if (!(await behavior.matches(context))) {
        continue;
      }

      const result = await behavior.execute(context);
      if (result === BehaviorResult.StopPropagation) {
        return result;
      }

      if (result === BehaviorResult.Handled) {
        finalResult = result;
      }
    }

    return finalResult;
  }
}
