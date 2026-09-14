import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      nowPlayingMessageId: "now-playing-id",
      lyricsMessageId: "lyrics-id",
      queueMessageId: "queue-id",
    });

    const restoredStore = new LocalControlPanelStateStore(directory);

    expect(restoredStore.find("guild-id")).toEqual({
      guildId: "guild-id",
      channelId: "channel-id",
      nowPlayingMessageId: "now-playing-id",
      lyricsMessageId: "lyrics-id",
      queueMessageId: "queue-id",
    });
  });

  it("writes formatted JSON without temporary-file residue", async () => {
    const directory = temporaryDirectory();
    const store = new LocalControlPanelStateStore(directory);
    await store.save({
      guildId: "guild-id",
      channelId: "channel-id",
      nowPlayingMessageId: "now-playing-id",
      lyricsMessageId: "lyrics-id",
      queueMessageId: "queue-id",
    });

    const document = readFileSync(join(directory, "control-panels.json"), "utf8");
    expect(document).toContain('"nowPlayingMessageId": "now-playing-id"');
    expect(document.endsWith("\n")).toBe(true);
  });

  it("removes persisted state", async () => {
    const directory = temporaryDirectory();
    const store = new LocalControlPanelStateStore(directory);
    await store.save({
      guildId: "guild-id",
      channelId: "channel-id",
      nowPlayingMessageId: "now-playing-id",
      lyricsMessageId: "lyrics-id",
      queueMessageId: "queue-id",
    });

    await store.delete("guild-id");

    expect(new LocalControlPanelStateStore(directory).find("guild-id")).toBeNull();
  });

  it("normalizes a legacy pre-split single-message row into a needs-recreating trio", () => {
    const directory = temporaryDirectory();
    writeFileSync(
      join(directory, "control-panels.json"),
      `${JSON.stringify({
        "guild-id": { guildId: "guild-id", channelId: "channel-id", messageId: "old-message-id" },
      }, null, 2)}\n`,
      "utf8",
    );

    const store = new LocalControlPanelStateStore(directory);

    expect(store.find("guild-id")).toEqual({
      guildId: "guild-id",
      channelId: "channel-id",
      nowPlayingMessageId: "old-message-id",
      lyricsMessageId: null,
      queueMessageId: null,
    });
  });
});
