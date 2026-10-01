import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { GeneratedImage, ImageAssetStore } from "../../../application/campaign/ports/image-ports.js";

const extensions: Readonly<Record<GeneratedImage["mediaType"], string>> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const safe = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, "_");

// Keeps made pictures as files under the runtime data directory until they are
// posted, so a restart between painting and posting loses nothing.
export class FileImageAssetStore implements ImageAssetStore {
  public constructor(private readonly directory: string) {}

  public async save(key: { guildId: string; campaignId: string }, sceneId: string, image: GeneratedImage): Promise<void> {
    await mkdir(this.folder(key), { recursive: true });
    await this.remove(key, sceneId);
    await writeFile(join(this.folder(key), `${safe(sceneId)}.${extensions[image.mediaType]}`), image.bytes);
  }

  public async load(key: { guildId: string; campaignId: string }, sceneId: string): Promise<GeneratedImage | undefined> {
    for (const [mediaType, extension] of Object.entries(extensions) as [GeneratedImage["mediaType"], string][]) {
      try {
        return { bytes: await readFile(join(this.folder(key), `${safe(sceneId)}.${extension}`)), mediaType };
      } catch {
        // Not saved under this type.
      }
    }
    return undefined;
  }

  public async remove(key: { guildId: string; campaignId: string }, sceneId: string): Promise<void> {
    for (const extension of Object.values(extensions)) await rm(join(this.folder(key), `${safe(sceneId)}.${extension}`), { force: true });
  }

  public async removeAll(key: { guildId: string; campaignId: string }): Promise<void> {
    await rm(this.folder(key), { recursive: true, force: true });
  }

  private folder(key: { guildId: string; campaignId: string }): string {
    return join(this.directory, safe(key.guildId), safe(key.campaignId));
  }
}
