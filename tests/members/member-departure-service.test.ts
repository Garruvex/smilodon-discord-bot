import { describe, expect, it, vi } from "vitest";

import { MemberDepartureService } from "../../src/application/members/member-departure-service.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { MemberDataPurger } from "../../src/application/members/member-data-purger.js";

function stubPurger(): { purger: MemberDataPurger; purge: ReturnType<typeof vi.fn> } {
  const purge = vi.fn().mockResolvedValue(undefined);
  return { purger: { purge }, purge };
}

function stubProvider(retainMemberDataOnLeave: boolean | undefined): GuildConfigurationProvider {
  const profile = retainMemberDataOnLeave === undefined
    ? null
    : ({ features: { retainMemberDataOnLeave } } as unknown as GuildConfiguration);
  return {
    initialize: () => Promise.resolve(),
    find: () => profile,
    require: () => profile as GuildConfiguration,
    getAll: () => (profile ? [profile] : []),
    create: () => Promise.reject(new Error("not used")),
    update: () => Promise.reject(new Error("not used")),
    reload: () => Promise.resolve(),
  };
}

describe("MemberDepartureService", () => {
  it("retains data by default (toggle unset or true)", async () => {
    const { purger, purge } = stubPurger();

    await new MemberDepartureService(stubProvider(undefined), purger).handleMemberLeave("guild", "user");
    await new MemberDepartureService(stubProvider(true), purger).handleMemberLeave("guild", "user");

    expect(purge).not.toHaveBeenCalled();
  });

  it("purges the member's data when the guild has explicitly opted out of retention", async () => {
    const { purger, purge } = stubPurger();

    await new MemberDepartureService(stubProvider(false), purger).handleMemberLeave("guild", "user");

    expect(purge).toHaveBeenCalledWith("guild", "user");
  });
});
