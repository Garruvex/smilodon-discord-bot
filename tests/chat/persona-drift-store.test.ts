import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PersonaDriftStore } from "../../src/application/chat/persona-drift-store.js";

const guildId = "123456789012345678";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function store(): { runtimeDirectory: string; store: PersonaDriftStore } {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "persona-drift-store-"));
  temporaryDirectories.push(runtimeDirectory);
  return { runtimeDirectory, store: new PersonaDriftStore(runtimeDirectory) };
}

describe("PersonaDriftStore", () => {
  it("returns null when nothing has been written yet", async () => {
    const { store: driftStore } = store();

    await expect(driftStore.get(guildId)).resolves.toBeNull();
  });

  it("persists and reads back an evolved drift text", async () => {
    const { store: driftStore } = store();

    await driftStore.evolve(guildId, "A little more playful lately.");
    const state = await driftStore.get(guildId);

    expect(state?.text).toBe("A little more playful lately.");
    expect(state?.history).toEqual([]);
  });

  it("appends the previous text to history on each subsequent evolve", async () => {
    const { store: driftStore } = store();

    await driftStore.evolve(guildId, "First mood.");
    await driftStore.evolve(guildId, "Second mood.");
    const state = await driftStore.get(guildId);

    expect(state?.text).toBe("Second mood.");
    expect(state?.history).toHaveLength(1);
    expect(state?.history[0]?.text).toBe("First mood.");
  });

  it("serializes read-transform-write evolution for the same guild", async () => {
    const { store: driftStore } = store();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const seenCurrentTexts: string[] = [];

    const first = driftStore.evolveFrom(guildId, async (currentText) => {
      seenCurrentTexts.push(currentText);
      markFirstStarted();
      await firstGate;
      return "First mood.";
    });
    await firstStarted;
    const second = driftStore.evolveFrom(guildId, (currentText) => {
      seenCurrentTexts.push(currentText);
      return Promise.resolve("Second mood.");
    });

    releaseFirst();
    await Promise.all([first, second]);

    expect(seenCurrentTexts).toEqual(["", "First mood."]);
    await expect(driftStore.get(guildId)).resolves.toMatchObject({
      text: "Second mood.",
      history: [{ text: "First mood." }],
    });
  });

  it("clears both text and history on reset", async () => {
    const { store: driftStore } = store();
    await driftStore.evolve(guildId, "First mood.");
    await driftStore.evolve(guildId, "Second mood.");

    await driftStore.reset(guildId);

    await expect(driftStore.get(guildId)).resolves.toBeNull();
  });

  it("resetting a guild that never evolved is a no-op, not an error", async () => {
    const { runtimeDirectory, store: driftStore } = store();

    await expect(driftStore.reset(guildId)).resolves.toBeUndefined();
    expect(existsSync(join(runtimeDirectory, "guild-assets", guildId, "persona-drift.json"))).toBe(false);
  });
});
