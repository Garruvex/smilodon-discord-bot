export enum BehaviorEvent {
  MessageCreated = "message_created",
  VoiceStateUpdated = "voice_state_updated",
}

export enum BehaviorResult {
  Continue = "continue",
  Handled = "handled",
  StopPropagation = "stop_propagation",
}

export interface BotBehavior<TContext = unknown> {
  readonly id: string;
  readonly event: BehaviorEvent;
  readonly priority: number;

  matches(context: TContext): Promise<boolean>;
  execute(context: TContext): Promise<BehaviorResult>;
}

