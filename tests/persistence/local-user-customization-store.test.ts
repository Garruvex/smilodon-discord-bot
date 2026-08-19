import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalUserCustomizationStore } from "../../src/infrastructure/persistence/local-user-customization-store.js";

describe("LocalUserCustomizationStore", () => {
  it("returns null when nothing has been saved", async () => {
    const directory = mkdtempSync(join(tmpdir(), "user-customization-"));
    const store = new LocalUserCustomizationStore(directory);
    await store.initialize();
    await expect(store.load("guild", "user")).resolves.toBeNull();
  });

  it("saves and reloads customization text across store instances", async () => {
    const directory = mkdtempSync(join(tmpdir(), "user-customization-"));
    const store = new LocalUserCustomizationStore(directory);
    await store.initialize();
    await store.save("guild", "user", "Call me 阿龍.");

    const reloaded = new LocalUserCustomizationStore(directory);
    await reloaded.initialize();
    await expect(reloaded.load("guild", "user")).resolves.toBe("Call me 阿龍.");
  });

  it("clears saved customization", async () => {
    const directory = mkdtempSync(join(tmpdir(), "user-customization-"));
    const store = new LocalUserCustomizationStore(directory);
    await store.initialize();
    await store.save("guild", "user", "Be playful.");
    await store.clear("guild", "user");
    await expect(store.load("guild", "user")).resolves.toBeNull();
  });

  it("keeps customization scoped per guild and per user", async () => {
    const directory = mkdtempSync(join(tmpdir(), "user-customization-"));
    const store = new LocalUserCustomizationStore(directory);
    await store.initialize();
    await store.save("guild-a", "user", "A");
    await store.save("guild-b", "user", "B");
    await store.save("guild-a", "other-user", "C");

    await expect(store.load("guild-a", "user")).resolves.toBe("A");
    await expect(store.load("guild-b", "user")).resolves.toBe("B");
    await expect(store.load("guild-a", "other-user")).resolves.toBe("C");
  });
});
