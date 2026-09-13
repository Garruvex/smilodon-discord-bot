export type BoostEventType = "started" | "ended";

export interface BoostEvent {
  eventType: BoostEventType;
  occurredAt: Date;
}

export interface BoostHistoryStore {
  initialize(): Promise<void>;
  recordEvent(guildId: string, userId: string, eventType: BoostEventType, occurredAt: Date): Promise<void>;
  listEvents(guildId: string, userId: string): Promise<readonly BoostEvent[]>;
  removeForUser(guildId: string, userId: string): Promise<void>;
}
