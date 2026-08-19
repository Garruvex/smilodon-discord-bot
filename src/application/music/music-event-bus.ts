export interface MusicStateChangedEvent {
  guildId: string;
  reason:
    | "track_started"
    | "queue_changed"
    | "paused"
    | "resumed"
    | "stopped"
    | "volume_changed"
    | "player_destroyed";
}

export type MusicStateChangedListener = (
  event: MusicStateChangedEvent,
) => Promise<void>;

export class MusicEventBus {
  private readonly listeners = new Set<MusicStateChangedListener>();

  public subscribe(listener: MusicStateChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async publish(event: MusicStateChangedEvent): Promise<void> {
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
}
