import type { BehaviorEvent, BotBehavior } from "./behavior.js";

export class BehaviorRegistry {
  private readonly behaviors = new Map<BehaviorEvent, BotBehavior[]>();
  private readonly behaviorIds = new Set<string>();

  public register(behavior: BotBehavior): void {
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

  public findByEvent(event: BehaviorEvent): readonly BotBehavior[] {
    return [...(this.behaviors.get(event) ?? [])];
  }
}
