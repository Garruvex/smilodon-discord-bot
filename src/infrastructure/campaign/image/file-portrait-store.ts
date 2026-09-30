import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CharacterPortraitStore, GeneratedImage, PortraitSlot } from "../../../application/campaign/ports/image-ports.js";

const extensions: Readonly<Record<GeneratedImage["mediaType"], string>> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const safe = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, "_");
const draftSlots: readonly PortraitSlot[] = ["candidate", "source"];

// Keeps a library character's portrait as a file under the runtime data
// directory, one folder per character. The portrait is the only slot meant to
// last; a candidate and the upload it came from are drafts.
export class FilePortraitStore implements CharacterPortraitStore {
  public constructor(private readonly directory: string) {}

  public async saveImage(characterId: string, slot: PortraitSlot, image: GeneratedImage): Promise<void> {
    await mkdir(this.folder(characterId), { recursive: true });
    await this.removeImage(characterId, slot);
    await writeFile(join(this.folder(characterId), `${slot}.${extensions[image.mediaType]}`), image.bytes);
  }

  public async loadImage(characterId: string, slot: PortraitSlot): Promise<GeneratedImage | undefined> {
    for (const [mediaType, extension] of Object.entries(extensions) as [GeneratedImage["mediaType"], string][]) {
      try {
        return { bytes: await readFile(join(this.folder(characterId), `${slot}.${extension}`)), mediaType };
      } catch {
        // Not saved under this type.
      }
    }
    return undefined;
  }

  public async removeImage(characterId: string, slot: PortraitSlot): Promise<void> {
    for (const extension of Object.values(extensions)) await rm(join(this.folder(characterId), `${slot}.${extension}`), { force: true });
  }

  public async saveNote(characterId: string, text: string): Promise<void> {
    await mkdir(this.folder(characterId), { recursive: true });
    await writeFile(join(this.folder(characterId), "note.json"), text, "utf8");
  }

  public async loadNote(characterId: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.folder(characterId), "note.json"), "utf8");
    } catch {
      return undefined;
    }
  }

  public async removeAll(characterId: string): Promise<void> {
    await rm(this.folder(characterId), { recursive: true, force: true });
  }

  public async sweepDrafts(olderThanMs: number): Promise<number> {
    let removed = 0;
    let folders: string[];
    try {
      folders = await readdir(this.directory);
    } catch {
      return 0;
    }
    for (const folder of folders) {
      let files: string[];
      try {
        files = await readdir(join(this.directory, folder));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!draftSlots.some((slot) => file.startsWith(`${slot}.`))) continue;
        try {
          const path = join(this.directory, folder, file);
          if (Date.now() - (await stat(path)).mtimeMs > olderThanMs) {
            await rm(path, { force: true });
            removed += 1;
          }
        } catch {
          // Gone already.
        }
      }
    }
    return removed;
  }

  private folder(characterId: string): string {
    return join(this.directory, safe(characterId));
  }
}
