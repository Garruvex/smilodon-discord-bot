import type { Message } from "discord.js";
import type { Logger } from "pino";

import { texts } from "../../../application/i18n/texts.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { decideTrapResponse } from "../../../domain/security/trap-policy.js";
import { SecurityEnforcer, messageSubject } from "./security-enforcer.js";

// Deals with a message posted in a guild's trap channel. The channel exists
// to catch compromised accounts and spam bots: nothing legitimate is ever
// posted there, so the sender is removed from play and their recent spam is
// cleaned up. Everything that could hit a real person (staff, the owner, bot
// admins, exempt roles, members the bot outranks) is decided in
// decideTrapResponse and refused there.
export class TrapService {
  public constructor(
    private readonly profiles: GuildConfigurationProvider,
    private readonly logger: Logger,
    now: () => number = Date.now,
    private readonly enforcer: SecurityEnforcer = new SecurityEnforcer(logger, now),
  ) {}

  // True when the message was in the trap channel and was dealt with, so
  // nothing else (chat, link fixing) should answer it.
  public async handle(message: Message<true>): Promise<boolean> {
    const profile = this.profiles.find(message.guildId);
    const trap = profile?.security.trap;
    if (!profile || !trap?.enabled || trap.channelId !== message.channelId) return false;

    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    const decision = decideTrapResponse(messageSubject(message, member, profile), trap);
    if (decision.kind === "skip") return false;

    // The message goes first: whatever happens next, the spam is gone.
    await message.delete().catch((error: unknown) => {
      this.logger.warn({ error, guildId: message.guildId, messageId: message.id }, "Unable to delete a trap channel message");
    });
    if (!member) return true;

    const { outcome, removed } = await this.enforcer.respond({
      member,
      response: trap,
      blocked: decision.kind === "blocked",
      at: message.createdTimestamp,
    });

    const text = texts[profile.language].security.trap;
    const params = {
      user: `<@${message.author.id}>`,
      channel: `<#${message.channelId}>`,
      action: text.action[trap.action],
      removed,
    };
    await this.enforcer.report(profile, message.guild, text.log[outcome](params));
    return true;
  }
}
