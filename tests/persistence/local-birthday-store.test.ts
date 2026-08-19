import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalBirthdayStore } from "../../src/infrastructure/persistence/local-birthday-store.js";

describe("LocalBirthdayStore", () => {
  it("sets, retrieves, and lists birthdays for a guild", async () => {
    const directory = mkdtempSync(join(tmpdir(), "birthdays-"));
    const store = new LocalBirthdayStore(directory);
    await store.initialize();

    await store.setBirthday("guild", "userA", 3, 14);
    await store.setBirthday("guild", "userB", 3, 14);
    await store.setBirthday("guild", "userC", 6, 1);

    expect(await store.getBirthday("guild", "userA")).toEqual({ userId: "userA", month: 3, day: 14 });
    expect(await store.getBirthday("guild", "missing")).toBeNull();
    expect(await store.listForGuildOnDate("guild", 3, 14)).toEqual(["userA", "userB"]);
    expect(await store.listForGuildOnDate("guild", 6, 1)).toEqual(["userC"]);
    expect(await store.listForGuildOnDate("guild", 1, 1)).toEqual([]);
  });

  it("overwrites an existing birthday on re-set", async () => {
    const directory = mkdtempSync(join(tmpdir(), "birthdays-"));
    const store = new LocalBirthdayStore(directory);
    await store.setBirthday("guild", "user", 1, 1);
    await store.setBirthday("guild", "user", 12, 25);
    expect(await store.getBirthday("guild", "user")).toEqual({ userId: "user", month: 12, day: 25 });
  });

  it("removes a birthday and reports whether one existed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "birthdays-"));
    const store = new LocalBirthdayStore(directory);
    await store.setBirthday("guild", "user", 1, 1);
    expect(await store.removeBirthday("guild", "user")).toBe(true);
    expect(await store.removeBirthday("guild", "user")).toBe(false);
    expect(await store.getBirthday("guild", "user")).toBeNull();
  });

  it("tracks announcement dedupe per guild and date", async () => {
    const directory = mkdtempSync(join(tmpdir(), "birthdays-"));
    const store = new LocalBirthdayStore(directory);
    expect(await store.hasAnnounced("guild", "2026-03-14")).toBe(false);
    await store.markAnnounced("guild", "2026-03-14");
    expect(await store.hasAnnounced("guild", "2026-03-14")).toBe(true);
    expect(await store.hasAnnounced("guild", "2027-03-14")).toBe(false);
  });

  it("persists across store instances backed by the same directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "birthdays-"));
    const store = new LocalBirthdayStore(directory);
    await store.setBirthday("guild", "user", 7, 4);

    const reloaded = new LocalBirthdayStore(directory);
    expect(await reloaded.getBirthday("guild", "user")).toEqual({ userId: "user", month: 7, day: 4 });
  });
});
