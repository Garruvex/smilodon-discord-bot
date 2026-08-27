import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalReminderStore } from "../../src/infrastructure/persistence/local-reminder-store.js";

describe("LocalReminderStore", () => {
  it("creates and lists a user's pending reminders, ordered by due time", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reminders-"));
    const store = new LocalReminderStore(directory);
    await store.initialize();

    await store.create({ guildId: "guild", userId: "user", channelId: "channel", message: "later", delivery: "dm", dueAt: 2_000 });
    await store.create({ guildId: "guild", userId: "user", channelId: "channel", message: "sooner", delivery: "dm", dueAt: 1_000 });
    await store.create({ guildId: "guild", userId: "otherUser", channelId: "channel", message: "not mine", delivery: "dm", dueAt: 500 });

    const reminders = await store.listForUser("guild", "user");
    expect(reminders.map((r) => r.message)).toEqual(["sooner", "later"]);
  });

  it("only returns due, unfired reminders from listDue", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reminders-"));
    const store = new LocalReminderStore(directory);

    const due = await store.create({ guildId: "guild", userId: "user", channelId: "channel", message: "due", delivery: "dm", dueAt: 1_000 });
    await store.create({ guildId: "guild", userId: "user", channelId: "channel", message: "not yet", delivery: "dm", dueAt: 5_000 });

    expect((await store.listDue(2_000)).map((r) => r.id)).toEqual([due.id]);

    await store.markFired(due.id);
    expect(await store.listDue(2_000)).toEqual([]);
  });

  it("cancels a reminder only for its owner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reminders-"));
    const store = new LocalReminderStore(directory);

    const reminder = await store.create({ guildId: "guild", userId: "user", channelId: "channel", message: "test", delivery: "dm", dueAt: 1_000 });

    expect(await store.cancel(reminder.id, "someoneElse")).toBe(false);
    expect(await store.cancel(reminder.id, "user")).toBe(true);
    expect(await store.listForUser("guild", "user")).toEqual([]);
  });

  it("persists across store instances backed by the same directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reminders-"));
    const store = new LocalReminderStore(directory);
    await store.create({ guildId: "guild", userId: "user", channelId: "channel", message: "persisted", delivery: "dm", dueAt: 1_000 });

    const reloaded = new LocalReminderStore(directory);
    expect((await reloaded.listForUser("guild", "user")).map((r) => r.message)).toEqual(["persisted"]);
  });
});
