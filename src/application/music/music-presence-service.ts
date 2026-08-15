import { ActivityType, type Client } from "discord.js";
import type { Logger } from "pino";

import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type { MusicEventBus } from "./music-event-bus.js";
import type { MusicPlayerGateway, MusicPlayerSnapshot } from "./music-player-gateway.js";

export class MusicPresenceService {
  private refreshTimer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly client: Client,
    private readonly profiles: GuildConfigurationProvider,
    private readonly gateway: MusicPlayerGateway,
    private readonly logger: Logger,
    eventBus: MusicEventBus,
  ) {
    eventBus.subscribe(async () => this.refresh());
  }

  public start(): void {
    void this.refresh();
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => void this.refresh(), 15_000);
    this.refreshTimer.unref();
  }

  public stop(): void {
    if (!this.refreshTimer) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  public refresh(): Promise<void> {
    const user = this.client.user;
    if (!user) return Promise.resolve();
    const active = this.profiles
      .getAll()
      .map((profile) => this.gateway.getSnapshot(profile.guildId))
      .filter((snapshot): snapshot is MusicPlayerSnapshot => Boolean(snapshot?.currentTrack));

    try {
      if (active.length === 0) {
        user.setPresence({
          status: "online",
          activities: [{ name: "music requests", type: ActivityType.Listening }],
        });
      } else if (active.length > 1) {
        user.setPresence({
          status: "online",
          activities: [{
            name: `music in ${active.length} servers`,
            type: ActivityType.Listening,
            state: "Multiple players active",
          }],
        });
      } else {
        const snapshot = active[0]!;
        const track = snapshot.currentTrack!;
        const progress = `${this.formatDuration(track.positionMs)} / ${this.formatDuration(track.durationMs)}`;
        user.setPresence({
          status: snapshot.paused ? "idle" : "online",
          activities: [{
            name: this.truncate(track.title, 128),
            type: ActivityType.Listening,
            state: this.truncate(`${snapshot.paused ? "⏸" : "🎵"} ${track.author} • ${progress}`, 128),
          }],
        });
      }
    } catch (error) {
      this.logger.warn({ error }, "Unable to update Discord music presence");
    }
    return Promise.resolve();
  }

  private formatDuration(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    const remainder = String(seconds % 60).padStart(2, "0");
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`
      : `${minutes}:${remainder}`;
  }

  private truncate(value: string, maximum: number): string {
    return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
  }
}
