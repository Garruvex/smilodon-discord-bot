import type { Message } from "discord.js";

export enum BehaviorEvent {
  MessageCreated = "message_created",
  VoiceStateUpdated = "voice_state_updated",
}

export enum BehaviorResult {
  Continue = "continue",
  Handled = "handled",
  StopPropagation = "stop_propagation",
}

// Ties each BehaviorEvent to the context type behaviors registered for it
// receive, so BotBehavior/BehaviorRegistry/BehaviorDispatcher can be typed
// end to end instead of relying on an unchecked cast at dispatch time.
// VoiceStateUpdated has no registered behavior yet — left as `unknown`
// rather than guessing a shape nothing exercises; give it a real type once
// one exists.
export interface BehaviorContextMap {
  [BehaviorEvent.MessageCreated]: Message;
  [BehaviorEvent.VoiceStateUpdated]: unknown;
}

export interface BotBehavior<TEvent extends BehaviorEvent = BehaviorEvent> {
  readonly id: string;
  readonly event: TEvent;
  readonly priority: number;

  matches(context: BehaviorContextMap[TEvent]): Promise<boolean>;
  execute(context: BehaviorContextMap[TEvent]): Promise<BehaviorResult>;
}
