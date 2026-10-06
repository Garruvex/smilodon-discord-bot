import type { Message } from "discord.js";
import type { Logger } from "pino";

import { texts } from "../../../application/i18n/texts.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { inspectLinks } from "../../../domain/security/link-inspection.js";
import { decideTrapResponse } from "../../../domain/security/trap-policy.js";
import { SecurityEnforcer, messageSubject } from "./security-enforcer.js";
import { linkReasonTextKey } from "./security-text-keys.js";

const noticeLifetimeMs = 10_000;

// Removes messages carrying links the server has said it doesn't want: hosts
// on its block list, lookalikes of well-known brands, raw IP addresses and,
// if asked, invites to other servers. A link is judged by its name alone; it
// is never fetched, so nothing a member posts is sent anywhere.
export class LinkGuardService {
  public constructor(
    private readonly profiles: GuildConfigurationProvider,
    private readonly logger: Logger,
    now: () => number = Date.now,
    private readonly enforcer: SecurityEnforcer = new SecurityEnforcer(logger, now),
  ) {}

  public enabledFor(guildId: string): boolean {
    return this.profiles.find(guildId)?.security.links.enabled === true;
  }

  // True when the message held a refused link and was dealt with.
  public async handle(message: Message<true>): Promise<boolean> {
    const profile = this.profiles.find(message.guildId);
    const links = profile?.security.links;
    if (!profile || !links?.enabled || message.author.bot || message.webhookId !== null) return false;

    const [finding] = inspectLinks(message.content, links);
    if (!finding) return false;

    // Without the member there is no way to know they aren't staff, so
    // nothing is touched.
    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return false;
    const action = links.action;
    // Staff exemption is the same whatever the response; "can the bot act" only
    // matters when the response is more than removing the message.
    const decision = decideTrapResponse(messageSubject(message, member, profile), {
      action: action === "delete" || action === "report" ? "timeout" : action,
    });
    if (decision.kind === "skip") return false;

    const text = texts[profile.language].security;
    const params = {
      user: `<@${message.author.id}>`,
      channel: `<#${message.channelId}>`,
      host: finding.host,
      reason: text.links.reason[linkReasonTextKey[finding.reason]],
    };
    if (action === "report") {
      // Log only: the message stays, so everything else carries on as usual.
      await this.enforcer.report(profile, message.guild, text.links.log.reported(params));
      return false;
    }

    await message.delete().catch((error: unknown) => {
      this.logger.warn({ error, guildId: message.guildId, messageId: message.id }, "Unable to delete a message with a refused link");
    });

    if (action === "delete") {
      await this.notify(message, text.links.notice(params));
      await this.enforcer.report(profile, message.guild, text.links.log.removed(params));
      return true;
    }

    const { outcome, removed } = await this.enforcer.respond({
      member,
      response: { action, deleteWindow: links.deleteWindow, timeout: links.timeout },
      blocked: decision.kind === "blocked",
      at: message.createdTimestamp,
    });
    await this.enforcer.report(profile, message.guild, text.links.log[outcome]({
      ...params,
      action: text.trap.action[action],
      removed,
    }));
    return true;
  }

  // Tells the member why their message vanished, so a false positive isn't a
  // mystery. The notice tidies itself away; it is only for the one who posted.
  private async notify(message: Message<true>, content: string): Promise<void> {
    try {
      const notice = await message.channel.send({ content, allowedMentions: { users: [message.author.id] } });
      setTimeout(() => void notice.delete().catch(() => undefined), noticeLifetimeMs).unref();
    } catch (error) {
      this.logger.debug({ error, guildId: message.guildId }, "Unable to post a removed-link notice");
    }
  }
}
