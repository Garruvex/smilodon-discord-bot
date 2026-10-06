import type { Message } from "discord.js";
import type { Logger } from "pino";

import { texts } from "../../../application/i18n/texts.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { securityWindowMilliseconds } from "../../../domain/security/detection-policy.js";
import { SpamTracker, spamFingerprint } from "../../../domain/security/spam-tracker.js";
import { decideTrapResponse } from "../../../domain/security/trap-policy.js";
import { SecurityEnforcer, messageSubject } from "./security-enforcer.js";

// Catches the signature of a hacked account: one message posted across
// several channels in moments. Nothing is judged by what the message says, so
// it works on a scam in any language, or one that is just a picture.
export class SpamService {
  private readonly tracker = new SpamTracker();

  public constructor(
    private readonly profiles: GuildConfigurationProvider,
    logger: Logger,
    now: () => number = Date.now,
    private readonly enforcer: SecurityEnforcer = new SecurityEnforcer(logger, now),
  ) {}

  public enabledFor(guildId: string): boolean {
    return this.profiles.find(guildId)?.security.spam.enabled === true;
  }

  // True when the message completed a spam pattern and was dealt with.
  public async handle(message: Message<true>): Promise<boolean> {
    const profile = this.profiles.find(message.guildId);
    const spam = profile?.security.spam;
    if (!profile || !spam?.enabled || message.author.bot || message.webhookId !== null) return false;

    const fingerprint = spamFingerprint(
      message.content,
      [...message.attachments.values()].map((file) => ({ name: file.name, size: file.size })),
    );
    if (fingerprint === null) return false;

    const verdict = this.tracker.record(
      `${message.guildId}:${message.author.id}`,
      fingerprint,
      { channelId: message.channelId, messageId: message.id, at: message.createdTimestamp },
      securityWindowMilliseconds[spam.window],
      spam.channels,
    );
    if (!verdict.triggered) return false;

    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return false;
    const action = spam.action;
    // Staff exemption is the same whatever the response.
    const decision = decideTrapResponse(messageSubject(message, member, profile), {
      action: action === "report" ? "timeout" : action,
    });
    if (decision.kind === "skip") return false;

    const text = texts[profile.language].security;
    const user = `<@${message.author.id}>`;
    if (action === "report") {
      // Log only: the messages stay, so everything else carries on as usual.
      await this.enforcer.report(profile, message.guild, text.spam.log.reported({ user, channels: verdict.channels }));
      return false;
    }

    const { outcome, removed } = await this.enforcer.respond({
      member,
      response: { action, deleteWindow: spam.deleteWindow, timeout: spam.timeout },
      blocked: decision.kind === "blocked",
      at: message.createdTimestamp,
      tracked: verdict.posts,
    });
    await this.enforcer.report(profile, message.guild, text.spam.log[outcome]({
      user,
      channels: verdict.channels,
      action: text.trap.action[action],
      removed,
    }));
    return true;
  }
}
