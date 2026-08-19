import type { ApplicationEmoji, Client } from "discord.js";
import type { Logger } from "pino";

import { yohtaApplicationEmojiAssets } from "../../config/application-emoji-presets.js";
import type {
  ApplicationProgressBarEmojiReference,
  CustomProgressBarTheme,
} from "../../config/guild-configuration.js";

export class ApplicationEmojiCatalog {
  private readonly emojisByName = new Map<string, ApplicationProgressBarEmojiReference>();

  public constructor(
    private readonly client: Client,
    private readonly logger: Logger,
  ) {}

  public async initialize(): Promise<void> {
    const application = this.client.application;
    if (!application) throw new Error("Discord application is unavailable before client ready.");
    const emojis = await application.emojis.fetch();
    this.emojisByName.clear();
    for (const emoji of emojis.values()) {
      const reference = this.toReference(application.id, emoji);
      if (reference) this.emojisByName.set(reference.name, reference);
    }
    const missing = this.getMissingYohtaEmojiNames();
    if (missing.length > 0) {
      this.logger.warn(
        { applicationId: application.id, missingEmojiNames: missing },
        "Yohta application emoji preset is incomplete",
      );
    }
  }

  public getYohtaTheme(): CustomProgressBarTheme | null {
    const resolved = Object.fromEntries(
      yohtaApplicationEmojiAssets.map(({ slot, name }) => [slot, this.emojisByName.get(name)]),
    ) as Partial<Record<typeof yohtaApplicationEmojiAssets[number]["slot"], ApplicationProgressBarEmojiReference>>;
    if (!resolved.completed || !resolved.remaining || !resolved.playing || !resolved.paused || !resolved.ending) {
      return null;
    }
    return {
      completed: resolved.completed,
      remaining: resolved.remaining,
      playing: resolved.playing,
      paused: resolved.paused,
      ending: resolved.ending,
    };
  }

  public hasEmoji(emojiId: string): boolean {
    return [...this.emojisByName.values()].some((emoji) => emoji.id === emojiId);
  }

  public getMissingYohtaEmojiNames(): string[] {
    return yohtaApplicationEmojiAssets
      .filter(({ name }) => !this.emojisByName.has(name))
      .map(({ name }) => name);
  }

  private toReference(
    applicationId: string,
    emoji: ApplicationEmoji,
  ): ApplicationProgressBarEmojiReference | null {
    if (!emoji.name) return null;
    return {
      id: emoji.id,
      name: emoji.name,
      animated: emoji.animated ?? false,
      scope: "application",
      applicationId,
    };
  }
}
