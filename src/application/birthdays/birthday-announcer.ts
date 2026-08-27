import { EmbedBuilder, type Client, type TextChannel } from "discord.js";
import type { Logger } from "pino";

import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type { BirthdayStore } from "./birthday-store.js";

const checkIntervalMs = 60 * 60 * 1_000;

// Computes "today" in the guild's configured time zone rather than UTC, so a
// guild several hours behind/ahead of UTC doesn't have its birthday roll
// over at the wrong local moment (and, combined with the hourly check
// interval, doesn't risk processing yesterday's date after a restart).
function resolveGuildDate(now: Date, timeZone: string): { month: number; day: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const lookup = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { month: Number(lookup.month), day: Number(lookup.day), date: `${lookup.year}-${lookup.month}-${lookup.day}` };
}

export class BirthdayAnnouncer {
  private checkTimer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly client: Client,
    private readonly profiles: GuildConfigurationProvider,
    private readonly birthdayStore: BirthdayStore,
    private readonly logger: Logger,
  ) {}

  public start(): void {
    void this.checkNow(new Date());
    if (this.checkTimer) return;
    this.checkTimer = setInterval(() => void this.checkNow(new Date()), checkIntervalMs);
    this.checkTimer.unref();
  }

  public stop(): void {
    if (!this.checkTimer) return;
    clearInterval(this.checkTimer);
    this.checkTimer = null;
  }

  public async checkNow(now: Date): Promise<void> {
    for (const profile of this.profiles.getAll()) {
      if (!profile.features.birthdays || !profile.channels.birthdayAnnouncements) continue;

      try {
        const { month, day, date } = resolveGuildDate(now, profile.timezone);
        if (await this.birthdayStore.hasAnnounced(profile.guildId, date)) continue;

        const userIds = await this.birthdayStore.listForGuildOnDate(profile.guildId, month, day);
        if (userIds.length === 0) continue;

        const channel = await this.client.channels.fetch(profile.channels.birthdayAnnouncements).catch(() => null);
        // client.channels.fetch is global — it doesn't scope to this guild
        // on its own, so a stale/misconfigured channel id (e.g. left over
        // from a channel that got recreated, or copy-pasted from another
        // guild's config) could otherwise resolve to a channel in a
        // completely different guild and leak this guild's members'
        // birthdays into it.
        if (!channel?.isTextBased() || channel.isDMBased() || channel.guildId !== profile.guildId) {
          this.logger.warn(
            { guildId: profile.guildId, channelId: profile.channels.birthdayAnnouncements },
            "Birthday announcement channel is not a usable text channel in this guild",
          );
          continue;
        }

        const embed = new EmbedBuilder()
          .setColor(profile.embedColor as `#${string}`)
          .setTitle("🎂 Happy Birthday!")
          .setDescription(
            userIds.length === 1
              ? `Everyone wish <@${userIds[0]}> a happy birthday today!`
              : `Everyone wish these members a happy birthday today!\n${userIds.map((userId) => `<@${userId}>`).join("\n")}`,
          );
        await (channel as TextChannel).send({ embeds: [embed] });
        await this.birthdayStore.markAnnounced(profile.guildId, date);
      } catch (error) {
        this.logger.error({ error, guildId: profile.guildId }, "Birthday announcement check failed");
      }
    }
  }
}
