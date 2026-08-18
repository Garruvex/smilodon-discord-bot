import { EmbedBuilder, type Client, type TextChannel } from "discord.js";
import type { Logger } from "pino";

import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type { BirthdayStore } from "./birthday-store.js";

const checkIntervalMs = 60 * 60 * 1_000;

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
    const month = now.getUTCMonth() + 1;
    const day = now.getUTCDate();
    const date = `${now.getUTCFullYear()}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    for (const profile of this.profiles.getAll()) {
      if (!profile.features.birthdays || !profile.channels.birthdayAnnouncements) continue;

      try {
        if (await this.birthdayStore.hasAnnounced(profile.guildId, date)) continue;

        const userIds = await this.birthdayStore.listForGuildOnDate(profile.guildId, month, day);
        if (userIds.length === 0) continue;

        const channel = await this.client.channels.fetch(profile.channels.birthdayAnnouncements).catch(() => null);
        if (!channel?.isTextBased() || channel.isDMBased()) {
          this.logger.warn(
            { guildId: profile.guildId, channelId: profile.channels.birthdayAnnouncements },
            "Birthday announcement channel is not a usable text channel",
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
