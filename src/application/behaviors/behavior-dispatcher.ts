import { BehaviorResult, type BehaviorContextMap, type BehaviorEvent } from "./behavior.js";
import type { BehaviorRegistry } from "./behavior-registry.js";

export class BehaviorDispatcher {
  public constructor(private readonly registry: BehaviorRegistry) {}

  public async dispatch<TEvent extends BehaviorEvent>(
    event: TEvent,
    context: BehaviorContextMap[TEvent],
  ): Promise<BehaviorResult> {
    const behaviors = this.registry.findByEvent(event);
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
