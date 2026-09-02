import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import {
  defaultPersonality,
  FilePersonaSource,
} from "../../src/infrastructure/chat/file-persona-source.js";
import { PersonaDriftStore } from "../../src/application/chat/persona-drift-store.js";
import { hashContent } from "../../src/application/assets/content-hash.js";

const guildId = "123456789012345678";
const temporaryDirectories: string[] = [];

function profile(overrides: Partial<GuildConfiguration["chat"]> = {}): GuildConfiguration {
  return {
    guildId,
    chat: {
      personalityFile: null,
      personalityAsset: null,
      examplesFile: null,
      examplesAsset: null,
      ...overrides,
    },
  } as GuildConfiguration;
}

function logger(): Logger {
  return { warn: vi.fn() } as never;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("FilePersonaSource", () => {
  it("returns the stable default persona when no guild persona is configured", async () => {
    const source = new FilePersonaSource("unused", logger());

    await expect(source.resolve(profile())).resolves.toEqual({
      personality: defaultPersonality,
      loreChunks: [],
      examplePool: [],
      personaDrift: null,
      personalitySourceHash: hashContent(defaultPersonality),
    });
  });

  it("loads the configured uploaded persona", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "persona-source-"));
    temporaryDirectories.push(runtimeDirectory);
    const assetDirectory = join(runtimeDirectory, "guild-assets", guildId);
    mkdirSync(assetDirectory, { recursive: true });
    writeFileSync(join(assetDirectory, "personality.md"), "A stable custom persona.\n", "utf8");
    const source = new FilePersonaSource(runtimeDirectory, logger());

    const resolved = await source.resolve(profile({
      personalityAsset: `guild-assets/${guildId}/personality.md`,
    }));

    expect(resolved.personality).toBe("A stable custom persona.");
    expect(resolved.loreChunks).toEqual([]);
    expect(resolved.examplePool).toEqual([]);
  });

  it("uses a compiled bundle's core/chunks when its hash matches the current file", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "persona-source-"));
    temporaryDirectories.push(runtimeDirectory);
    const assetDirectory = join(runtimeDirectory, "guild-assets", guildId);
    mkdirSync(assetDirectory, { recursive: true });
    const content = "A stable custom persona.";
    writeFileSync(join(assetDirectory, "personality.md"), `${content}\n`, "utf8");
    const sourceHash = createHash("sha256").update(content, "utf8").digest("hex");
    writeFileSync(join(assetDirectory, "personality.bundle.json"), JSON.stringify({
      sourceHash,
      core: "Compiled core.",
      chunks: [{ heading: "Backstory", text: "Some lore.", embedding: null }],
      compiledAt: Date.now(),
    }), "utf8");
    const source = new FilePersonaSource(runtimeDirectory, logger());

    const resolved = await source.resolve(profile({
      personalityAsset: `guild-assets/${guildId}/personality.md`,
    }));

    expect(resolved.personality).toBe("Compiled core.");
    expect(resolved.loreChunks).toEqual([{ heading: "Backstory", text: "Some lore.", embedding: null }]);
  });

  it("falls back to the full file when the bundle's hash is stale", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "persona-source-"));
    temporaryDirectories.push(runtimeDirectory);
    const assetDirectory = join(runtimeDirectory, "guild-assets", guildId);
    mkdirSync(assetDirectory, { recursive: true });
    writeFileSync(join(assetDirectory, "personality.md"), "Edited persona.\n", "utf8");
    writeFileSync(join(assetDirectory, "personality.bundle.json"), JSON.stringify({
      sourceHash: "stale-hash",
      core: "Compiled core.",
      chunks: [],
      compiledAt: Date.now(),
    }), "utf8");
    const source = new FilePersonaSource(runtimeDirectory, logger());

    const resolved = await source.resolve(profile({
      personalityAsset: `guild-assets/${guildId}/personality.md`,
    }));

    expect(resolved.personality).toBe("Edited persona.");
    expect(resolved.loreChunks).toEqual([]);
  });

  it("uses a compiled examples bundle's embeddings when its hash matches the current file", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "persona-source-"));
    temporaryDirectories.push(runtimeDirectory);
    const assetDirectory = join(runtimeDirectory, "guild-assets", guildId);
    mkdirSync(assetDirectory, { recursive: true });
    const content = "### Example\nTags: greeting\nUser: hi\nCharacter: hey there";
    writeFileSync(join(assetDirectory, "examples.md"), `${content}\n`, "utf8");
    const sourceHash = createHash("sha256").update(content, "utf8").digest("hex");
    writeFileSync(join(assetDirectory, "examples.bundle.json"), JSON.stringify({
      sourceHash,
      exchanges: [{ tags: "greeting", user: "hi", character: "hey there", embedding: [1, 0] }],
    }), "utf8");
    const source = new FilePersonaSource(runtimeDirectory, logger());

    const resolved = await source.resolve(profile({
      examplesAsset: `guild-assets/${guildId}/examples.md`,
    }));

    expect(resolved.examplePool).toEqual([{ tags: "greeting", user: "hi", character: "hey there", embedding: [1, 0] }]);
  });

  it("falls back to plain parsing when the examples bundle's hash is stale", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "persona-source-"));
    temporaryDirectories.push(runtimeDirectory);
    const assetDirectory = join(runtimeDirectory, "guild-assets", guildId);
    mkdirSync(assetDirectory, { recursive: true });
    writeFileSync(join(assetDirectory, "examples.md"), "### Example\nTags: greeting\nUser: hi\nCharacter: hey there\n", "utf8");
    writeFileSync(join(assetDirectory, "examples.bundle.json"), JSON.stringify({
      sourceHash: "stale-hash",
      exchanges: [],
    }), "utf8");
    const source = new FilePersonaSource(runtimeDirectory, logger());

    const resolved = await source.resolve(profile({
      examplesAsset: `guild-assets/${guildId}/examples.md`,
    }));

    expect(resolved.examplePool).toEqual([{ tags: "greeting", user: "hi", character: "hey there" }]);
  });

  it("injects the evolved persona-drift text when the guild has it enabled", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "persona-source-"));
    temporaryDirectories.push(runtimeDirectory);
    const driftStore = new PersonaDriftStore(runtimeDirectory);
    const personalityHash = createHash("sha256").update(defaultPersonality, "utf8").digest("hex");
    await driftStore.evolve(guildId, "A little more playful lately.", personalityHash);
    const source = new FilePersonaSource(runtimeDirectory, logger(), driftStore);

    const resolved = await source.resolve(profile({ personaDriftEnabled: true }));

    expect(resolved.personaDrift).toBe("A little more playful lately.");
  });

  it("omits persona drift when the guild has it disabled, even if evolved state exists", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "persona-source-"));
    temporaryDirectories.push(runtimeDirectory);
    const driftStore = new PersonaDriftStore(runtimeDirectory);
    const personalityHash = createHash("sha256").update(defaultPersonality, "utf8").digest("hex");
    await driftStore.evolve(guildId, "A little more playful lately.", personalityHash);
    const source = new FilePersonaSource(runtimeDirectory, logger(), driftStore);

    const resolved = await source.resolve(profile({ personaDriftEnabled: false }));

    expect(resolved.personaDrift).toBeNull();
  });

  it("discards persona drift whose personalitySourceHash no longer matches the current personality content", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "persona-source-"));
    temporaryDirectories.push(runtimeDirectory);
    const driftStore = new PersonaDriftStore(runtimeDirectory);
    await driftStore.evolve(guildId, "A little more playful lately.", "stale-personality-hash");
    const source = new FilePersonaSource(runtimeDirectory, logger(), driftStore);

    const resolved = await source.resolve(profile({ personaDriftEnabled: true }));

    expect(resolved.personaDrift).toBeNull();
  });

  it("discards persona drift when only the bundle's lore changed, even though the core is unchanged", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "persona-source-"));
    temporaryDirectories.push(runtimeDirectory);
    const assetDirectory = join(runtimeDirectory, "guild-assets", guildId);
    mkdirSync(assetDirectory, { recursive: true });
    const content = "A stable custom persona.\nSome lore section.";
    writeFileSync(join(assetDirectory, "personality.md"), `${content}\n`, "utf8");
    const sourceHash = createHash("sha256").update(content, "utf8").digest("hex");
    writeFileSync(join(assetDirectory, "personality.bundle.json"), JSON.stringify({
      sourceHash,
      core: "Compiled core.",
      chunks: [{ heading: "Backstory", text: "Some lore section.", embedding: null }],
      compiledAt: Date.now(),
    }), "utf8");
    const driftStore = new PersonaDriftStore(runtimeDirectory);
    // Drift was evolved against the *core* text only (the old, buggy hash
    // basis) — a lore-only edit changes the file's sourceHash without
    // touching the core, so this must no longer match and the drift must
    // be discarded.
    await driftStore.evolve(guildId, "A little more playful lately.", hashContent("Compiled core."));
    const source = new FilePersonaSource(runtimeDirectory, logger(), driftStore);

    const resolved = await source.resolve(profile({
      personalityAsset: `guild-assets/${guildId}/personality.md`,
      personaDriftEnabled: true,
    }));

    expect(resolved.personaDrift).toBeNull();
    expect(resolved.personalitySourceHash).toBe(sourceHash);
  });

  it("drops a bundle's cached embeddings at read time when the active embeddings client no longer matches", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "persona-source-"));
    temporaryDirectories.push(runtimeDirectory);
    const assetDirectory = join(runtimeDirectory, "guild-assets", guildId);
    mkdirSync(assetDirectory, { recursive: true });
    const content = "A stable custom persona.";
    writeFileSync(join(assetDirectory, "personality.md"), `${content}\n`, "utf8");
    const sourceHash = createHash("sha256").update(content, "utf8").digest("hex");
    writeFileSync(join(assetDirectory, "personality.bundle.json"), JSON.stringify({
      sourceHash,
      core: "Compiled core.",
      chunks: [{ heading: "Backstory", text: "Some lore.", embedding: [1, 2, 3] }],
      compiledAt: Date.now(),
      embeddingModel: "openai:text-embedding-3-small",
    }), "utf8");
    // The active client is a different model than the one that produced the
    // bundle's cached vector — reading the bundle back must not hand out
    // that now-incompatible vector, even though the guild hasn't reuploaded
    // since the config changed.
    const source = new FilePersonaSource(runtimeDirectory, logger(), null, {
      embed: (): Promise<number[]> => Promise.resolve([0, 0, 0]),
      modelId: "gemini:text-embedding-004:3",
    });

    const resolved = await source.resolve(profile({
      personalityAsset: `guild-assets/${guildId}/personality.md`,
    }));

    expect(resolved.loreChunks).toEqual([{ heading: "Backstory", text: "Some lore.", embedding: null }]);
  });

  it("keeps a bundle's cached embeddings at read time when the active embeddings client still matches", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "persona-source-"));
    temporaryDirectories.push(runtimeDirectory);
    const assetDirectory = join(runtimeDirectory, "guild-assets", guildId);
    mkdirSync(assetDirectory, { recursive: true });
    const content = "A stable custom persona.";
    writeFileSync(join(assetDirectory, "personality.md"), `${content}\n`, "utf8");
    const sourceHash = createHash("sha256").update(content, "utf8").digest("hex");
    writeFileSync(join(assetDirectory, "personality.bundle.json"), JSON.stringify({
      sourceHash,
      core: "Compiled core.",
      chunks: [{ heading: "Backstory", text: "Some lore.", embedding: [1, 2, 3] }],
      compiledAt: Date.now(),
      embeddingModel: "openai:text-embedding-3-small",
    }), "utf8");
    const source = new FilePersonaSource(runtimeDirectory, logger(), null, {
      embed: (): Promise<number[]> => Promise.resolve([0, 0, 0]),
      modelId: "openai:text-embedding-3-small",
    });

    const resolved = await source.resolve(profile({
      personalityAsset: `guild-assets/${guildId}/personality.md`,
    }));

    expect(resolved.loreChunks).toEqual([{ heading: "Backstory", text: "Some lore.", embedding: [1, 2, 3] }]);
  });

  it("drops an examples bundle's cached embeddings at read time when the active embeddings client no longer matches", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "persona-source-"));
    temporaryDirectories.push(runtimeDirectory);
    const assetDirectory = join(runtimeDirectory, "guild-assets", guildId);
    mkdirSync(assetDirectory, { recursive: true });
    const content = "### Example\nTags: greeting\nUser: hi\nCharacter: hey there";
    writeFileSync(join(assetDirectory, "examples.md"), `${content}\n`, "utf8");
    const sourceHash = createHash("sha256").update(content, "utf8").digest("hex");
    writeFileSync(join(assetDirectory, "examples.bundle.json"), JSON.stringify({
      sourceHash,
      exchanges: [{ tags: "greeting", user: "hi", character: "hey there", embedding: [1, 0] }],
      embeddingModel: "openai:text-embedding-3-small",
    }), "utf8");
    const source = new FilePersonaSource(runtimeDirectory, logger(), null, {
      embed: (): Promise<number[]> => Promise.resolve([0, 0]),
      modelId: "gemini:text-embedding-004:2",
    });

    const resolved = await source.resolve(profile({
      examplesAsset: `guild-assets/${guildId}/examples.md`,
    }));

    expect(resolved.examplePool).toEqual([{ tags: "greeting", user: "hi", character: "hey there", embedding: null }]);
  });

  it("never truncates a personality core within the upload cap, even well past the old 32,000-char limit", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "persona-source-"));
    temporaryDirectories.push(runtimeDirectory);
    const assetDirectory = join(runtimeDirectory, "guild-assets", guildId);
    mkdirSync(assetDirectory, { recursive: true });
    // Under the 64 KB upload cap but comfortably over the old 32,000-char
    // truncation point — simulates a classifier leaving a large section in
    // core (or compilation failing and the full file falling back to core).
    const largeContent = "A".repeat(50_000);
    writeFileSync(join(assetDirectory, "personality.md"), `${largeContent}\n`, "utf8");
    const source = new FilePersonaSource(runtimeDirectory, logger());

    const resolved = await source.resolve(profile({
      personalityAsset: `guild-assets/${guildId}/personality.md`,
    }));

    expect(resolved.personality).toBe(largeContent);
  });
});
