import { describe, expect, it, vi } from "vitest";

import { MemberDepartureService } from "../../src/application/members/member-departure-service.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildMemberRegistry } from "../../src/infrastructure/persistence/guild-member-registry.js";

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
  it("does nothing on the local backend (no member registry)", async () => {
    const service = new MemberDepartureService(stubProvider(false), null);
    await service.handleMemberLeave("guild", "user");
    // No registry to assert against — the point is this doesn't throw.
  });

  it("retains data by default (toggle unset or true)", async () => {
    const deleteMember = vi.fn().mockResolvedValue(undefined);
    const registry = { resolveMemberId: vi.fn(), deleteMember } as unknown as GuildMemberRegistry;

    await new MemberDepartureService(stubProvider(undefined), registry).handleMemberLeave("guild", "user");
    await new MemberDepartureService(stubProvider(true), registry).handleMemberLeave("guild", "user");

    expect(deleteMember).not.toHaveBeenCalled();
  });

  it("deletes the member row when the guild has explicitly opted out of retention", async () => {
    const deleteMember = vi.fn().mockResolvedValue(undefined);
    const registry = { resolveMemberId: vi.fn(), deleteMember } as unknown as GuildMemberRegistry;

    await new MemberDepartureService(stubProvider(false), registry).handleMemberLeave("guild", "user");

    expect(deleteMember).toHaveBeenCalledWith("guild", "user");
  });
});
