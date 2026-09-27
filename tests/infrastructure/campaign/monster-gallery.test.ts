import { describe, expect, it } from "vitest";

import { monsterGalleryImage } from "../../../src/infrastructure/campaign/image/monster-gallery.js";

describe("the bundled monster gallery", () => {
  it("has a portrait for each monster the game content knows, as a WebP file", async () => {
    for (const id of ["monster:goblin", "monster:wolf", "monster:bugbear", "monster:giant-wolf-spider"]) {
      const image = await monsterGalleryImage(id);
      expect(image?.mediaType).toBe("image/webp");
      // A WebP file starts with "RIFF" and holds "WEBP" after the size.
      expect(image?.bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(image?.bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
    }
  });

  it("has nothing for an unknown monster, and never reads outside its folder", async () => {
    expect(await monsterGalleryImage("monster:tarrasque")).toBeUndefined();
    expect(await monsterGalleryImage("monster:../../package")).toBeUndefined();
    expect(await monsterGalleryImage("monster:")).toBeUndefined();
  });
});
