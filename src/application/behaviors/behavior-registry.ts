import type { BehaviorEvent, BotBehavior } from "./behavior.js";

export class BehaviorRegistry {
  private readonly behaviors = new Map<BehaviorEvent, BotBehavior[]>();
  private readonly behaviorIds = new Set<string>();

  public register<TEvent extends BehaviorEvent>(behavior: BotBehavior<TEvent>): void {
    if (this.behaviorIds.has(behavior.id)) {
      throw new Error(`Behavior "${behavior.id}" is already registered.`);
    }

    if (!Number.isSafeInteger(behavior.priority)) {
      throw new Error(`Behavior "${behavior.id}" must have an integer priority.`);
    }

    const eventBehaviors = this.behaviors.get(behavior.event) ?? [];
    eventBehaviors.push(behavior);
    eventBehaviors.sort((left, right) => right.priority - left.priority);

    this.behaviorIds.add(behavior.id);
    this.behaviors.set(behavior.event, eventBehaviors);
  }

  public findByEvent<TEvent extends BehaviorEvent>(event: TEvent): readonly BotBehavior<TEvent>[] {
    // Safe by construction: register() above only ever stores a behavior
    // under its own `event` key, so everything under this key was
    // registered as BotBehavior<TEvent>. A single Map can't express that
    // per-key invariant in its value type, hence the cast.
    return [...(this.behaviors.get(event) ?? [])] as unknown as readonly BotBehavior<TEvent>[];
  }
}
