import { EmbedBuilder, type Client, type TextChannel } from "discord.js";
import type { Logger } from "pino";

import type { ReminderRecord, ReminderStore } from "./reminder-store.js";

// Finer-grained than BirthdayAnnouncer/ChannelSummaryScheduler's hourly
// cadence — reminders have arbitrary per-user due times, and "in 1m" should
// still land within about a minute.
const checkIntervalMs = 60 * 1_000;

export class ReminderScheduler {
  private checkTimer: NodeJS.Timeout | null = null;
  // Same re-entrancy guard as ChannelSummaryScheduler — more important here
  // than for the hourly jobs, since a 60s interval is far more likely to
  // have an overlapping tick if delivery (DM fetch/send) is ever slow.
  private tickInFlight = false;

  public constructor(
    private readonly client: Client,
    private readonly reminderStore: ReminderStore,
    private readonly logger: Logger,
  ) {}

  public start(): void {
    void this.checkNow(Date.now());
    if (this.checkTimer) return;
    this.checkTimer = setInterval(() => void this.checkNow(Date.now()), checkIntervalMs);
    this.checkTimer.unref();
  }

  public stop(): void {
    if (!this.checkTimer) return;
    clearInterval(this.checkTimer);
    this.checkTimer = null;
  }

  public async checkNow(now: number): Promise<void> {
    if (this.tickInFlight) {
      this.logger.warn("Reminder tick skipped — previous tick still running.");
      return;
    }
    this.tickInFlight = true;
    try {
      const due = await this.reminderStore.listDue(now);
      for (const reminder of due) {
        try {
          await this.deliver(reminder);
        } catch (error) {
          this.logger.error({ error, reminderId: reminder.id }, "Reminder delivery failed");
        }
        // Marked fired regardless of delivery outcome — a permanently
        // undeliverable reminder (DMs closed and the origin channel gone)
        // must not retry forever; deliver() already logs which path (if
        // any) succeeded.
        await this.reminderStore.markFired(reminder.id);
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  private async deliver(reminder: ReminderRecord): Promise<void> {
    const embed = new EmbedBuilder()
      .setColor("#3B82F6")
      .setTitle("⏰ Reminder")
      .setDescription(reminder.message);

    try {
      const user = await this.client.users.fetch(reminder.userId);
      await user.send({ embeds: [embed] });
      return;
    } catch {
      // DMs closed (or the user is no longer reachable) — fall back to the
      // channel the reminder was created in.
    }

    const channel = await this.client.channels.fetch(reminder.channelId).catch(() => null);
    // Same guild-scoping care BirthdayAnnouncer.checkNow takes: channels.fetch
    // is global, so a stale channel id could otherwise resolve to a channel
    // in a completely different guild.
    if (!channel?.isTextBased() || channel.isDMBased() || channel.guildId !== reminder.guildId) {
      this.logger.warn(
        { reminderId: reminder.id, guildId: reminder.guildId, channelId: reminder.channelId },
        "Reminder undeliverable — DMs closed and origin channel unusable",
      );
      return;
    }

    await (channel as TextChannel).send({ content: `<@${reminder.userId}>`, embeds: [embed] });
  }
}
