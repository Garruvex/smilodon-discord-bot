import { ChannelType, PermissionsBitField, type PermissionResolvable } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminPanelHealth } from "../../src/application/settings/admin-panel-health.js";
import type { AdminPanelState, AdminPanelStateStore } from "../../src/application/settings/admin-panel-state-store.js";
import { AdminPanelService } from "../../src/infrastructure/discord/settings/panel/admin-panel-service.js";
import { engineFixture, guildId, slashValues, type EngineFixture } from "../helpers/settings-fixtures.js";

const botId = "700000000000000001";
const panelChannelId = "710000000000000001";

interface FakeMessage {
  id: string;
  content: unknown;
  edit: ReturnType<typeof vi.fn>;
  delete: () => Promise<void>;
}

type Mock = ReturnType<typeof vi.fn>;

interface FakeChannel {
  // What the service is handed as the channel.
  channel: unknown;
  messages: Map<string, FakeMessage>;
  send: Mock;
  editOverwrite: Mock;
  // Message ids still in the channel, in the order they were posted.
  visible: () => string[];
}

// Just enough of a text channel for the panel: messages that can be sent,
// fetched, edited and deleted, and permission overwrites.
function fakeChannel(options: { permitted?: (permission: PermissionResolvable) => boolean } = {}): FakeChannel {
  const messages = new Map<string, FakeMessage>();
  const order: string[] = [];
  const overwrites = new Map<string, { allow: PermissionsBitField; deny: PermissionsBitField }>();
  let nextId = 800000000000000000n;
  const everyone = { id: guildId };
  const me = { id: botId };
  const editOverwrite = vi.fn((target: { id: string }, permissions: Record<string, boolean>): Promise<void> => {
    const allow = new PermissionsBitField();
    const deny = new PermissionsBitField();
    for (const [name, value] of Object.entries(permissions)) {
      (value ? allow : deny).add(name as keyof typeof PermissionsBitField.Flags);
    }
    overwrites.set(target.id, { allow, deny });
    return Promise.resolve();
  });
  const send = vi.fn((payload: unknown): Promise<FakeMessage> => {
    const id = String(nextId++);
    const message: FakeMessage = {
      id,
      content: payload,
      edit: vi.fn(() => Promise.resolve()),
      delete: (): Promise<void> => {
        messages.delete(id);
        return Promise.resolve();
      },
    };
    messages.set(id, message);
    order.push(id);
    return Promise.resolve(message);
  });
  const channel = {
    id: panelChannelId,
    guildId,
    type: ChannelType.GuildText,
    guild: { id: guildId, roles: { everyone }, members: { me } },
    permissionsFor: (): { has(permission: PermissionResolvable): boolean } => ({
      has: (permission) => options.permitted?.(permission) ?? true,
    }),
    permissionOverwrites: { cache: overwrites, edit: editOverwrite },
    messages: {
      cache: new Map<string, FakeMessage>(),
      fetch: (id: string): Promise<FakeMessage | undefined> => (messages.has(id) ? Promise.resolve(messages.get(id)) : Promise.reject(new Error("Unknown Message"))),
    },
    send,
  };
  return {
    channel,
    messages,
    send,
    editOverwrite,
    visible: () => order.filter((id) => messages.has(id)),
  };
}

function memoryStore(): AdminPanelStateStore {
  const states = new Map<string, AdminPanelState>();
  return {
    initialize: () => Promise.resolve(),
    find: (id) => states.get(id) ?? null,
    save: (state): Promise<void> => {
      states.set(state.guildId, state);
      return Promise.resolve();
    },
    delete: (id): Promise<void> => {
      states.delete(id);
      return Promise.resolve();
    },
  };
}

interface Harness {
  fixture: EngineFixture;
  service: AdminPanelService;
  store: AdminPanelStateStore;
  health: AdminPanelHealth;
  audit: ReturnType<typeof vi.fn>;
  channel: FakeChannel;
  // Waits for every redraw queued so far.
  settle: () => Promise<void>;
}

async function harness(channel = fakeChannel()): Promise<Harness> {
  const fixture = engineFixture();
  await fixture.run("access.admin-panel", slashValues({ channel: { id: panelChannelId } }));
  const client = {
    user: { id: botId },
    guilds: { cache: new Map() },
    channels: { fetch: (id: string): Promise<unknown> => Promise.resolve(id === panelChannelId ? channel.channel : null) },
  };
  const store = memoryStore();
  const health = new AdminPanelHealth();
  const audit = vi.fn(() => Promise.resolve());
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const service = new AdminPanelService(
    client as never,
    fixture.profiles,
    fixture.engine,
    fixture.updater,
    store,
    health,
    { log: audit } as never,
    logger as never,
  );
  const settle = (): Promise<void> => service.refresh(guildId);
  await settle();
  return { fixture, service, store, health, audit, channel, settle };
}

const storedIds = (store: AdminPanelStateStore): Record<string, string> => ({ ...store.find(guildId)?.messages });

describe("AdminPanelService", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts the header and then every section, in order, with links to each", async () => {
    const { store, channel } = await harness();

    const ids = storedIds(store);
    expect(Object.keys(ids)[0]).toBe("header");
    expect(channel.visible()).toEqual(Object.values(ids));
    const header = JSON.stringify(channel.messages.get(ids.header!)!.edit.mock.calls.at(-1));
    expect(header).toContain(`https://discord.com/channels/${guildId}/${panelChannelId}/${ids["music#0"]}`);
  });

  it("only lets the bot post in the panel channel", async () => {
    const { channel } = await harness();

    expect(channel.editOverwrite).toHaveBeenCalledWith({ id: botId }, expect.objectContaining({ SendMessages: true }));
    expect(channel.editOverwrite).toHaveBeenCalledWith({ id: guildId }, { SendMessages: false });
  });

  it("reposts a deleted message, and everything after it, so the panel stays in order", async () => {
    const { service, store, channel, settle } = await harness();
    const before = storedIds(store);
    const deleted = before["music#0"]!;

    await channel.messages.get(deleted)!.delete();
    service.handleMessagesDeleted(guildId, panelChannelId, [deleted]);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();

    const after = storedIds(store);
    expect(after.header).toBe(before.header);
    expect(after["access#0"]).toBe(before["access#0"]);
    expect(after["music#0"]).not.toBe(deleted);
    expect(after["community#0"]).not.toBe(before["community#0"]);
    expect(channel.visible()).toEqual(Object.values(after));
  });

  it("doesn't mistake its own deletions for damage", async () => {
    const { service, channel, settle } = await harness();
    const sends = channel.send.mock.calls.length;

    await service.repair(guildId);
    const reposted = channel.send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();

    expect(reposted).toBeGreaterThan(sends);
    expect(channel.send.mock.calls.length).toBe(reposted);
  });

  it("stops reposting after repeated deletions, and says so once", async () => {
    const { service, store, health, audit, channel, settle } = await harness();
    const deleteHeader = async (): Promise<void> => {
      const id = storedIds(store).header!;
      await channel.messages.get(id)?.delete();
      service.handleMessagesDeleted(guildId, panelChannelId, [id]);
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
    };

    for (let heal = 0; heal < 3; heal += 1) await deleteHeader();
    expect(channel.messages.has(storedIds(store).header!)).toBe(true);
    await deleteHeader();

    expect(channel.messages.has(storedIds(store).header!)).toBe(false);
    expect(health.get(guildId)).toContainEqual({ kind: "healing-paused", channelId: panelChannelId });
    expect(audit).toHaveBeenCalledTimes(1);

    // A repair starts it again.
    await service.repair(guildId);
    expect(channel.messages.has(storedIds(store).header!)).toBe(true);
    expect(health.get(guildId)).toEqual([]);
  });

  it("turns the panel off, audited, when its channel is deleted", async () => {
    const { fixture, service, health } = await harness();

    await service.handleChannelDeleted(guildId, panelChannelId);

    expect(fixture.profiles.current().channels.adminPanel).toBeNull();
    expect(health.get(guildId)).toEqual([{ kind: "channel-deleted" }]);
  });

  it("reports missing permissions instead of posting", async () => {
    const channel = fakeChannel({ permitted: (permission) => permission !== "SendMessages" });
    const { health } = await harness(channel);

    expect(channel.send).not.toHaveBeenCalled();
    expect(health.get(guildId)).toEqual([
      { kind: "missing-permissions", channelId: panelChannelId, permissions: ["SendMessages"] },
    ]);
  });
});
