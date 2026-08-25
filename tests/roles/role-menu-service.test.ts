import type { GuildTextBasedChannel, Role } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { RoleMenuService } from "../../src/application/roles/role-menu-service.js";
import type { RoleMenuStore } from "../../src/application/roles/role-menu-store.js";

function fakeLogger(): Logger {
  const noop = (): void => undefined;
  const logger = { info: noop, warn: noop, error: noop, child: (): Logger => fakeLogger() };
  return logger as unknown as Logger;
}

function fakeStore(): { store: RoleMenuStore; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(() => Promise.resolve());
  const store: RoleMenuStore = {
    initialize: () => Promise.resolve(),
    create,
    find: () => Promise.resolve(null),
    listForGuild: () => Promise.resolve([]),
    remove: () => Promise.resolve(false),
  };
  return { store, create };
}

interface FakeChannel {
  id: string;
  guild: { id: string; members: { me: { roles: { highest: { position: number } } } } };
  send: ReturnType<typeof vi.fn>;
}

function fakeChannel(botHighestPosition: number): FakeChannel {
  return {
    id: "channel1",
    guild: {
      id: "guild1",
      members: { me: { roles: { highest: { position: botHighestPosition } } } },
    },
    send: vi.fn(() => Promise.resolve({ id: "message1" })),
  };
}

function asChannel(channel: FakeChannel): GuildTextBasedChannel {
  return channel as unknown as GuildTextBasedChannel;
}

interface FakeRole {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  guild: { id: string };
}

function fakeRole(id: string, position: number, overrides: Partial<{ managed: boolean; guildId: string }> = {}): Role {
  const role: FakeRole = {
    id, name: id, position,
    managed: overrides.managed ?? false,
    guild: { id: overrides.guildId ?? "guild1" },
  };
  return role as unknown as Role;
}

describe("RoleMenuService.createMenu", () => {
  it("rejects a role positioned above the bot's own highest role", async () => {
    const service = new RoleMenuService(fakeStore().store, fakeLogger());
    const channel = fakeChannel(5);
    const role = fakeRole("role1", 10);

    const result = await service.createMenu(asChannel(channel), "Pick a role", [role]);

    expect(result).toEqual({
      ok: false,
      message: "I can't manage <@&role1> — move my role above it in Server Settings → Roles.",
    });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("rejects a managed (integration-owned) role", async () => {
    const service = new RoleMenuService(fakeStore().store, fakeLogger());
    const channel = fakeChannel(10);
    const role = fakeRole("role1", 1, { managed: true });

    const result = await service.createMenu(asChannel(channel), "Pick a role", [role]);

    expect(result.ok).toBe(false);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("rejects the @everyone role", async () => {
    const service = new RoleMenuService(fakeStore().store, fakeLogger());
    const channel = fakeChannel(10);
    const role = fakeRole("guild1", 0, { guildId: "guild1" });

    const result = await service.createMenu(asChannel(channel), "Pick a role", [role]);

    expect(result.ok).toBe(false);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("posts the menu and persists it when every role is manageable", async () => {
    const { store, create } = fakeStore();
    const service = new RoleMenuService(store, fakeLogger());
    const channel = fakeChannel(10);
    const role = fakeRole("role1", 1);

    const result = await service.createMenu(asChannel(channel), "Pick a role", [role]);

    expect(result).toEqual({ ok: true });
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      guildId: "guild1", channelId: "channel1", messageId: "message1",
      options: [{ roleId: "role1", label: "role1" }],
    });
  });
});
