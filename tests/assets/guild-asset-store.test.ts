import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Attachment } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GuildAssetStore } from "../../src/application/assets/guild-asset-store.js";
import { PersonaBundleCompiler } from "../../src/application/chat/persona-bundle-compiler.js";
import { parsePersonaBundle } from "../../src/application/chat/persona-bundle.js";
import { parseExampleExchangeBundle } from "../../src/application/chat/example-exchange-bundle.js";
import type { ChatProvider } from "../../src/application/chat/chat-provider.js";
import type { EmbeddingsClient } from "../../src/application/chat/embeddings-client.js";

const guildId = "123456789012345678";
const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function stubDownload(content: string): void {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(content, { status: 200 }))));
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function stubImageDownload(bytes: Buffer = pngSignature): void {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(bytes, { status: 200 }))));
}

function imageAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    name: "reference.png",
    size: 1024,
    url: "https://example.com/reference.png",
    contentType: "image/png",
    ...overrides,
  } as Attachment;
}

function personalityAttachment(): Attachment {
  return { name: "personality.md", size: 1024, url: "https://example.com/personality.md" } as Attachment;
}

function examplesAttachment(): Attachment {
  return { name: "examples.md", size: 1024, url: "https://example.com/examples.md" } as Attachment;
}

describe("GuildAssetStore.savePersonality", () => {
  it("writes a compiled bundle sidecar when a compiler is configured and compilation succeeds", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "guild-asset-store-"));
    temporaryDirectories.push(runtimeDirectory);
    stubDownload("## Voice\nAlways playful.\n\n## Backstory\nBorn in a forest.");
    const provider: ChatProvider = {
      reply: () => Promise.reject(new Error("not used")),
      compilePersonaBundle: () => Promise.resolve([1]),
    };
    const store = new GuildAssetStore(runtimeDirectory, new PersonaBundleCompiler(provider, null));

    const { loreHeadings } = await store.savePersonality(guildId, personalityAttachment());

    expect(loreHeadings).toEqual(["Backstory"]);
    const bundlePath = join(runtimeDirectory, "guild-assets", guildId, "personality.bundle.json");
    expect(existsSync(bundlePath)).toBe(true);
    const bundle = parsePersonaBundle(readFileSync(bundlePath, "utf8"));
    expect(bundle?.core).toBe("## Voice\nAlways playful.");
    expect(bundle?.chunks).toEqual([{ heading: "Backstory", text: "Born in a forest.", embedding: null }]);
  });

  it("degrades cleanly (no bundle, upload still succeeds) when compilation fails", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "guild-asset-store-"));
    temporaryDirectories.push(runtimeDirectory);
    stubDownload("## Voice\nAlways playful.");
    const provider: ChatProvider = {
      reply: () => Promise.reject(new Error("not used")),
      compilePersonaBundle: () => Promise.reject(new Error("provider unavailable")),
    };
    const store = new GuildAssetStore(runtimeDirectory, new PersonaBundleCompiler(provider, null));

    const { assetPath, loreHeadings } = await store.savePersonality(guildId, personalityAttachment());

    expect(assetPath).toBe(`guild-assets/${guildId}/personality.md`);
    expect(loreHeadings).toEqual([]);
    const bundlePath = join(runtimeDirectory, "guild-assets", guildId, "personality.bundle.json");
    expect(existsSync(bundlePath)).toBe(false);
  });

  it("passes the guild's existing bundle to the compiler on reupload, so unchanged chunks can reuse their embedding", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "guild-asset-store-"));
    temporaryDirectories.push(runtimeDirectory);
    stubDownload("## Voice\nAlways playful.\n\n## Backstory\nBorn in a forest.");
    const embed = vi.fn(() => Promise.resolve([9, 9]));
    const provider: ChatProvider = {
      reply: () => Promise.reject(new Error("not used")),
      compilePersonaBundle: () => Promise.resolve([1]),
    };
    const store = new GuildAssetStore(
      runtimeDirectory,
      new PersonaBundleCompiler(provider, { embed, modelId: "test-model" }),
    );
    await store.savePersonality(guildId, personalityAttachment());
    expect(embed).toHaveBeenCalledTimes(1);

    // Reuploading identical content should reuse the "Backstory" chunk's
    // embedding from the bundle just written, rather than embedding again.
    await store.savePersonality(guildId, personalityAttachment());

    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("skips compilation entirely (no bundle, no error) when no compiler is configured", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "guild-asset-store-"));
    temporaryDirectories.push(runtimeDirectory);
    stubDownload("## Voice\nAlways playful.");
    const store = new GuildAssetStore(runtimeDirectory);

    await store.savePersonality(guildId, personalityAttachment());

    const bundlePath = join(runtimeDirectory, "guild-assets", guildId, "personality.bundle.json");
    expect(existsSync(bundlePath)).toBe(false);
  });
});

describe("GuildAssetStore.saveExamples", () => {
  it("writes an embedded bundle sidecar when an embeddings client is configured", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "guild-asset-store-"));
    temporaryDirectories.push(runtimeDirectory);
    stubDownload("### Example\nTags: greeting\nUser: hi\nCharacter: hey there");
    const embeddingsClient: EmbeddingsClient = { embed: () => Promise.resolve([1, 0]), modelId: "test-model" };
    const store = new GuildAssetStore(runtimeDirectory, null, embeddingsClient);

    await store.saveExamples(guildId, examplesAttachment());

    const bundlePath = join(runtimeDirectory, "guild-assets", guildId, "examples.bundle.json");
    expect(existsSync(bundlePath)).toBe(true);
    const bundle = parseExampleExchangeBundle(readFileSync(bundlePath, "utf8"));
    expect(bundle?.exchanges).toEqual([{ tags: "greeting", user: "hi", character: "hey there", embedding: [1, 0] }]);
  });

  it("degrades a single exchange to a null embedding (bundle still written, upload still succeeds) when embedding fails", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "guild-asset-store-"));
    temporaryDirectories.push(runtimeDirectory);
    stubDownload("### Example\nTags: greeting\nUser: hi\nCharacter: hey there");
    const embeddingsClient: EmbeddingsClient = { embed: () => Promise.reject(new Error("down")), modelId: "test-model" };
    const store = new GuildAssetStore(runtimeDirectory, null, embeddingsClient);

    const asset = await store.saveExamples(guildId, examplesAttachment());

    expect(asset).toBe(`guild-assets/${guildId}/examples.md`);
    const bundlePath = join(runtimeDirectory, "guild-assets", guildId, "examples.bundle.json");
    expect(existsSync(bundlePath)).toBe(true);
    const bundle = parseExampleExchangeBundle(readFileSync(bundlePath, "utf8"));
    expect(bundle?.exchanges).toEqual([{ tags: "greeting", user: "hi", character: "hey there", embedding: null }]);
  });

  it("skips embedding entirely (no bundle, no error) when no embeddings client is configured", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "guild-asset-store-"));
    temporaryDirectories.push(runtimeDirectory);
    stubDownload("### Example\nTags: greeting\nUser: hi\nCharacter: hey there");
    const store = new GuildAssetStore(runtimeDirectory);

    await store.saveExamples(guildId, examplesAttachment());

    const bundlePath = join(runtimeDirectory, "guild-assets", guildId, "examples.bundle.json");
    expect(existsSync(bundlePath)).toBe(false);
  });
});

describe("GuildAssetStore self-reference image", () => {
  it("saves, reads back, and removes a self-reference image", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "guild-asset-store-"));
    temporaryDirectories.push(runtimeDirectory);
    stubImageDownload();
    const store = new GuildAssetStore(runtimeDirectory);

    const assetPath = await store.saveSelfReferenceImage(guildId, imageAttachment());
    expect(assetPath).toBe(`guild-assets/${guildId}/self-reference.png`);
    expect(existsSync(join(runtimeDirectory, assetPath))).toBe(true);

    const read = await store.readAsset(assetPath);
    expect(read?.contentType).toBe("image/png");
    expect(read?.data.equals(pngSignature)).toBe(true);

    await store.removeSelfReferenceImage(assetPath);
    expect(existsSync(join(runtimeDirectory, assetPath))).toBe(false);
  });

  it("rejects an unsupported content type", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "guild-asset-store-"));
    temporaryDirectories.push(runtimeDirectory);
    const store = new GuildAssetStore(runtimeDirectory);

    await expect(store.saveSelfReferenceImage(guildId, imageAttachment({ contentType: "application/pdf" })))
      .rejects.toThrow(/PNG, JPEG, WebP, or GIF/);
  });

  it("rejects an attachment over the size cap", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "guild-asset-store-"));
    temporaryDirectories.push(runtimeDirectory);
    const store = new GuildAssetStore(runtimeDirectory);

    await expect(store.saveSelfReferenceImage(guildId, imageAttachment({ size: 9 * 1024 * 1024 })))
      .rejects.toThrow(/8 MB/);
  });

  it("replaces a stale extension when the content type changes on re-upload", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "guild-asset-store-"));
    temporaryDirectories.push(runtimeDirectory);
    const store = new GuildAssetStore(runtimeDirectory);

    stubImageDownload();
    await store.saveSelfReferenceImage(guildId, imageAttachment());
    expect(existsSync(join(runtimeDirectory, "guild-assets", guildId, "self-reference.png"))).toBe(true);

    stubImageDownload();
    const newPath = await store.saveSelfReferenceImage(
      guildId, imageAttachment({ name: "reference.jpg", url: "https://example.com/reference.jpg", contentType: "image/jpeg" }),
    );
    expect(newPath).toBe(`guild-assets/${guildId}/self-reference.jpg`);
    expect(existsSync(join(runtimeDirectory, "guild-assets", guildId, "self-reference.png"))).toBe(false);
    expect(existsSync(join(runtimeDirectory, newPath))).toBe(true);
  });

  it("readAsset refuses a path outside the guild-assets root", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "guild-asset-store-"));
    temporaryDirectories.push(runtimeDirectory);
    const store = new GuildAssetStore(runtimeDirectory);

    expect(await store.readAsset("../outside.png")).toBeNull();
    expect(await store.readAsset(`guild-assets/${guildId}/self-reference.png`)).toBeNull();
  });
});
