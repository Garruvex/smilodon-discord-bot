import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PersonaDriftStore } from "../../src/application/chat/persona-drift-store.js";

const guildId = "123456789012345678";
const personalityHash = "hash-v1";
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

    await driftStore.evolve(guildId, "A little more playful lately.", personalityHash);
    const state = await driftStore.get(guildId);

    expect(state?.text).toBe("A little more playful lately.");
    expect(state?.history).toEqual([]);
  });

  it("appends the previous text to history on each subsequent evolve", async () => {
    const { store: driftStore } = store();

    await driftStore.evolve(guildId, "First mood.", personalityHash);
    await driftStore.evolve(guildId, "Second mood.", personalityHash);
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

    const first = driftStore.evolveFrom(guildId, personalityHash, async (currentText) => {
      seenCurrentTexts.push(currentText);
      markFirstStarted();
      await firstGate;
      return "First mood.";
    });
    await firstStarted;
    const second = driftStore.evolveFrom(guildId, personalityHash, (currentText) => {
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

  it("evolveFrom starts fresh (empty currentText) when the stored drift's personalitySourceHash no longer matches", async () => {
    const { store: driftStore } = store();
    await driftStore.evolve(guildId, "Old mood from the old personality.", "hash-v1");

    const seenCurrentTexts: string[] = [];
    await driftStore.evolveFrom(guildId, "hash-v2", (currentText) => {
      seenCurrentTexts.push(currentText);
      return Promise.resolve("New mood.");
    });

    expect(seenCurrentTexts).toEqual([""]);
    await expect(driftStore.get(guildId)).resolves.toMatchObject({
      text: "New mood.",
      personalitySourceHash: "hash-v2",
    });
  });

  it("evolveFrom persists an explicit empty-string result as clearing the current drift", async () => {
    const { store: driftStore } = store();
    await driftStore.evolve(guildId, "An established mood.", personalityHash);

    await driftStore.evolveFrom(guildId, personalityHash, () => Promise.resolve(""));

    // Persisted (not left at the old text) — see PersonaDriftEvolver's doc
    // comment: "" means "nothing worth noting yet," an explicit clear, not
    // "no change." The old text moves to history like any other transition.
    await expect(driftStore.get(guildId)).resolves.toMatchObject({
      text: "",
      history: [{ text: "An established mood." }],
    });
  });

  it("evolveFrom is a true no-op when the result is unchanged from the current text", async () => {
    const { store: driftStore } = store();
    await driftStore.evolve(guildId, "Steady mood.", personalityHash);

    await driftStore.evolveFrom(guildId, personalityHash, (currentText) => Promise.resolve(currentText));

    const state = await driftStore.get(guildId);
    expect(state?.text).toBe("Steady mood.");
    expect(state?.history).toEqual([]);
  });

  it("evolveFrom does not write when there is no current drift and the result is also empty", async () => {
    const { runtimeDirectory, store: driftStore } = store();

    await driftStore.evolveFrom(guildId, personalityHash, () => Promise.resolve(""));

    expect(existsSync(join(runtimeDirectory, "guild-assets", guildId, "persona-drift.json"))).toBe(false);
  });

  it("clears both text and history on reset", async () => {
    const { store: driftStore } = store();
    await driftStore.evolve(guildId, "First mood.", personalityHash);
    await driftStore.evolve(guildId, "Second mood.", personalityHash);

    await driftStore.reset(guildId);

    await expect(driftStore.get(guildId)).resolves.toBeNull();
  });

  it("resetting a guild that never evolved is a no-op, not an error", async () => {
    const { runtimeDirectory, store: driftStore } = store();

    await expect(driftStore.reset(guildId)).resolves.toBeUndefined();
    expect(existsSync(join(runtimeDirectory, "guild-assets", guildId, "persona-drift.json"))).toBe(false);
  });
});
