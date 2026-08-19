import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalControlPanelStateStore } from "../../src/infrastructure/persistence/local-control-panel-state-store.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "fntu-panel-state-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("LocalControlPanelStateStore", () => {
  it("persists and restores panel message identities", async () => {
    const directory = temporaryDirectory();
    const firstStore = new LocalControlPanelStateStore(directory);
    await firstStore.save({
      guildId: "guild-id",
      channelId: "channel-id",
      messageId: "message-id",
    });

    const restoredStore = new LocalControlPanelStateStore(directory);

    expect(restoredStore.find("guild-id")).toEqual({
      guildId: "guild-id",
      channelId: "channel-id",
      messageId: "message-id",
    });
  });

  it("writes formatted JSON without temporary-file residue", async () => {
    const directory = temporaryDirectory();
    const store = new LocalControlPanelStateStore(directory);
    await store.save({
      guildId: "guild-id",
      channelId: "channel-id",
      messageId: "message-id",
    });

    const document = readFileSync(join(directory, "control-panels.json"), "utf8");
    expect(document).toContain('"messageId": "message-id"');
    expect(document.endsWith("\n")).toBe(true);
  });

  it("removes persisted state", async () => {
    const directory = temporaryDirectory();
    const store = new LocalControlPanelStateStore(directory);
    await store.save({
      guildId: "guild-id",
      channelId: "channel-id",
      messageId: "message-id",
    });

    await store.delete("guild-id");

    expect(new LocalControlPanelStateStore(directory).find("guild-id")).toBeNull();
  });
});
