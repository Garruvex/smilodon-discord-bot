import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalRoleMenuStore } from "../../src/infrastructure/persistence/local-role-menu-store.js";

describe("LocalRoleMenuStore", () => {
  it("creates and finds a role menu by message id", async () => {
    const directory = mkdtempSync(join(tmpdir(), "role-menus-"));
    const store = new LocalRoleMenuStore(directory);
    await store.initialize();

    await store.create({
      guildId: "guild", channelId: "channel", messageId: "message1",
      options: [{ roleId: "role1", label: "Gamer" }, { roleId: "role2", label: "Artist" }],
    });

    const found = await store.find("message1");
    expect(found?.options).toEqual([{ roleId: "role1", label: "Gamer" }, { roleId: "role2", label: "Artist" }]);
    expect(await store.find("missing")).toBeNull();
  });

  it("lists menus for a guild only", async () => {
    const directory = mkdtempSync(join(tmpdir(), "role-menus-"));
    const store = new LocalRoleMenuStore(directory);

    await store.create({ guildId: "guildA", channelId: "c", messageId: "m1", options: [] });
    await store.create({ guildId: "guildB", channelId: "c", messageId: "m2", options: [] });

    const menus = await store.listForGuild("guildA");
    expect(menus.map((m) => m.messageId)).toEqual(["m1"]);
  });

  it("removes a menu and reports whether one existed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "role-menus-"));
    const store = new LocalRoleMenuStore(directory);
    await store.create({ guildId: "guild", channelId: "c", messageId: "m1", options: [] });

    expect(await store.remove("m1")).toBe(true);
    expect(await store.remove("m1")).toBe(false);
    expect(await store.find("m1")).toBeNull();
  });

  it("persists across store instances backed by the same directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "role-menus-"));
    const store = new LocalRoleMenuStore(directory);
    await store.create({ guildId: "guild", channelId: "c", messageId: "m1", options: [{ roleId: "r", label: "Role" }] });

    const reloaded = new LocalRoleMenuStore(directory);
    expect((await reloaded.find("m1"))?.options).toEqual([{ roleId: "r", label: "Role" }]);
  });
});
