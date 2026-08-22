import { describe, expect, it, vi } from "vitest";

import { MemberDepartureService } from "../../src/application/members/member-departure-service.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildMemberRegistry } from "../../src/infrastructure/persistence/guild-member-registry.js";
import type { MemoryEngine } from "../../src/application/memory/memory.js";

function stubMemoryEngine(): { engine: MemoryEngine; forget: ReturnType<typeof vi.fn> } {
  const forget = vi.fn().mockResolvedValue(0);
  const engine: MemoryEngine = {
    recall: vi.fn().mockResolvedValue({ memories: [], causalChains: [] }),
    ingest: vi.fn().mockResolvedValue({ ingested: [], removed: 0, rejected: 0, failed: 0 }),
    ingestRelations: vi.fn().mockResolvedValue({ created: 0, rejected: 0 }),
    listUserMemories: vi.fn().mockResolvedValue([]),
    forget,
  };
  return { engine, forget };
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
  it("does nothing on the local backend (no member registry)", async () => {
    const service = new MemberDepartureService(stubProvider(false), null, stubMemoryEngine().engine);
    await service.handleMemberLeave("guild", "user");
    // No registry to assert against — the point is this doesn't throw.
  });

  it("retains data by default (toggle unset or true)", async () => {
    const deleteMember = vi.fn().mockResolvedValue(undefined);
    const registry = { resolveMemberId: vi.fn(), deleteMember } as unknown as GuildMemberRegistry;
    const { engine, forget } = stubMemoryEngine();

    await new MemberDepartureService(stubProvider(undefined), registry, engine).handleMemberLeave("guild", "user");
    await new MemberDepartureService(stubProvider(true), registry, engine).handleMemberLeave("guild", "user");

    expect(deleteMember).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
  });

  it("deletes the member row and their owned memories when the guild has explicitly opted out of retention", async () => {
    const deleteMember = vi.fn().mockResolvedValue(undefined);
    const registry = { resolveMemberId: vi.fn(), deleteMember } as unknown as GuildMemberRegistry;
    const { engine, forget } = stubMemoryEngine();

    await new MemberDepartureService(stubProvider(false), registry, engine).handleMemberLeave("guild", "user");

    expect(deleteMember).toHaveBeenCalledWith("guild", "user");
    expect(forget).toHaveBeenCalledWith({ guildId: "guild", ownerUserId: "user" });
  });
});
