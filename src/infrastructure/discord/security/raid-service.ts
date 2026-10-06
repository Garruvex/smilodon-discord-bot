import type { GuildMember } from "discord.js";
import type { Logger } from "pino";

import { texts } from "../../../application/i18n/texts.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { securityWindowMilliseconds } from "../../../domain/security/detection-policy.js";
import { JoinTracker, accountAgeDays, type TrackedJoin } from "../../../domain/security/join-tracker.js";
import { decideTrapResponse } from "../../../domain/security/trap-policy.js";
import { SecurityEnforcer, memberSubject } from "./security-enforcer.js";
import { windowTextKey } from "./security-text-keys.js";

// Notices many accounts joining at once. The first time the threshold is
// crossed staff are told; after that, unless the response is "alert only",
// everyone who joined in the burst (and anyone joining while it lasts) gets
// the configured action, optionally only if their account is new.
export class RaidService {
  private readonly tracker = new JoinTracker();

  public constructor(
    private readonly profiles: GuildConfigurationProvider,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly enforcer: SecurityEnforcer = new SecurityEnforcer(logger, now),
  ) {}

  public async handleJoin(member: GuildMember): Promise<void> {
    const profile = this.profiles.find(member.guild.id);
    const raid = profile?.security.raid;
    if (!profile || !raid?.enabled || member.user.bot) return;

    const verdict = this.tracker.record(
      member.guild.id,
      { userId: member.id, at: this.now(), accountCreatedAt: member.user.createdTimestamp },
      securityWindowMilliseconds[raid.window],
      raid.joins,
    );
    if (!verdict.raid) return;

    const text = texts[profile.language].security;
    const windowLabel = text.window[windowTextKey[raid.window]];
    if (raid.action === "alert") {
      if (verdict.started) {
        await this.enforcer.report(profile, member.guild, text.raid.log.alert({ count: verdict.affected.length, window: windowLabel }));
      }
      return;
    }

    const targets = raid.accountAgeDays > 0
      ? verdict.affected.filter((join) => accountAgeDays(join) < raid.accountAgeDays)
      : verdict.affected;
    let acted = 0;
    let failed = 0;
    for (const join of targets) {
      const outcome = await this.deal(member, join, profile);
      if (outcome === "acted") acted += 1;
      else if (outcome === "failed") failed += 1;
    }

    if (verdict.started) {
      await this.enforcer.report(profile, member.guild, text.raid.log.acted({
        count: verdict.affected.length,
        window: windowLabel,
        acted,
        failed,
        action: text.trap.action[raid.action],
      }));
    }
  }

  private async deal(
    joined: GuildMember,
    join: TrackedJoin,
    profile: NonNullable<ReturnType<GuildConfigurationProvider["find"]>>,
  ): Promise<"acted" | "failed" | "skipped"> {
    const raid = profile.security.raid;
    if (raid.action === "alert") return "skipped";
    // The member who just joined is in hand; earlier ones are looked up, and
    // one who already left is simply gone.
    const target = join.userId === joined.id
      ? joined
      : joined.guild.members.cache.get(join.userId) ?? await joined.guild.members.fetch(join.userId).catch(() => null);
    if (!target) return "skipped";

    const decision = decideTrapResponse(memberSubject(target, profile), { action: raid.action });
    if (decision.kind === "skip") return "skipped";
    if (decision.kind === "blocked") return "failed";

    const { outcome } = await this.enforcer.respond({
      member: target,
      response: { action: raid.action, deleteWindow: "off", timeout: raid.timeout },
      at: join.at,
    });
    if (outcome !== "acted") this.logger.warn({ guildId: target.guild.id, userId: target.id }, "Unable to act on a raid joiner");
    return outcome === "acted" ? "acted" : "failed";
  }
}
