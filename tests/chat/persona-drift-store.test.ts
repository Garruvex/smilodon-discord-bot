import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PersonaDriftStore } from "../../src/application/chat/persona-drift-store.js";
import { seedLegacyDrift } from "../helpers/legacy-drift-fixture.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(): { directory: string; store: PersonaDriftStore } {
  const directory = mkdtempSync(join(tmpdir(), "scoped-drift-")); directories.push(directory);
  return { directory, store: new PersonaDriftStore(directory) };
}
describe("scoped persona drift storage", () => {
  it("exposes no global read/evolution API and never promotes a legacy file", async () => {
    const { directory, store } = fixture(); await seedLegacyDrift(directory, "guild", "PRIVATE_LEGACY_STATE", "hash");
    expect("get" in store).toBe(false); expect("evolve" in store).toBe(false); expect("evolveFrom" in store).toBe(false);
    expect(await store.getScoped("guild", "channel")).toBeNull();
  });
  it("ignores malformed scoped state and rejects path traversal", async () => {
    const { directory, store } = fixture(); const assets = join(directory, "guild-assets", "guild"); mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "persona-drift.channel.json"), '{"text":"unproven"}');
    expect(await store.getScoped("guild", "channel")).toBeNull();
    await expect(store.getScoped("../escape", "channel")).rejects.toThrow("Invalid drift scope");
    await expect(store.getScoped("guild", "../escape")).rejects.toThrow("Invalid drift scope");
  });
  it("reset erases global/scoped/epoch files while preserving authored assets and other guilds", async () => {
    const { directory, store } = fixture(); await seedLegacyDrift(directory, "guild", "legacy", "hash"); await seedLegacyDrift(directory, "other", "other", "hash");
    const assets = join(directory, "guild-assets", "guild");
    for (const name of ["persona-drift.channel.json", "persona-drift.channel.epoch.json", "personality.md"]) writeFileSync(join(assets, name), "fixture");
    await store.reset("guild");
    for (const name of ["persona-drift.json", "persona-drift.channel.json", "persona-drift.channel.epoch.json"]) expect(existsSync(join(assets, name))).toBe(false);
    expect(existsSync(join(assets, "personality.md"))).toBe(true); expect(existsSync(join(directory, "guild-assets", "other", "persona-drift.json"))).toBe(true);
    await expect(store.reset("missing")).resolves.toBeUndefined();
  });
});
