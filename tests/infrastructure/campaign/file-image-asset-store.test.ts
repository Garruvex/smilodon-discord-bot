import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileImageAssetStore } from "../../../src/infrastructure/campaign/image/file-image-asset-store.js";

const image = { bytes: Buffer.from([1, 2, 3]), mediaType: "image/png" } as const;
let directory = "";
afterEach(async () => {
  if (directory !== "") await rm(directory, { recursive: true, force: true });
});

describe("file image asset store", () => {
  it("removes every picture a game left, and only that game's", async () => {
    directory = await mkdtemp(join(tmpdir(), "images-"));
    const store = new FileImageAssetStore(directory);
    const ended = { guildId: "g", campaignId: "c1" };
    const other = { guildId: "g", campaignId: "c2" };
    await store.save(ended, "scene:a", image);
    await store.save(ended, "scene:b", image);
    await store.save(other, "scene:a", image);
    await store.removeAll(ended);
    expect(await store.load(ended, "scene:a")).toBeUndefined();
    expect(await store.load(ended, "scene:b")).toBeUndefined();
    expect(await store.load(other, "scene:a")).toBeDefined();
    await expect(store.removeAll(ended)).resolves.toBeUndefined();
  });
});
