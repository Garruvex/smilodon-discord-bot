import type { GuildMember, PartialGuildMember } from "discord.js";

import type { BoostHistoryStore } from "./boost-history-store.js";

// Discord only exposes a member's *current* premiumSince — it has no memory
// of past boost periods. This logs each start/stop transition so total time
// boosted (and, by subtraction, time as a non-boosting member) can be
// reconstructed later. Reacts to GuildMemberUpdate, which fires on every
// member profile change (roles, nickname, etc.) — most of which aren't
// boost-related, hence the early return below.
export class BoostTrackingService {
  public constructor(private readonly boostHistoryStore: BoostHistoryStore) {}

  public async handleMemberUpdate(
    oldMember: GuildMember | PartialGuildMember,
    newMember: GuildMember,
  ): Promise<void> {
    const wasBoosting = oldMember.premiumSince !== null;
    const isBoosting = newMember.premiumSince !== null;
    if (wasBoosting === isBoosting) return;

    await this.boostHistoryStore.recordEvent(
      newMember.guild.id,
      newMember.id,
      isBoosting ? "started" : "ended",
      isBoosting ? newMember.premiumSince : new Date(),
    );
  }
}
