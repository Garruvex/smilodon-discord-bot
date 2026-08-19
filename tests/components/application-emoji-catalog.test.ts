import { describe, expect, it, vi } from "vitest";

import { ApplicationEmojiCatalog } from "../../src/infrastructure/discord/application-emoji-catalog.js";

describe("ApplicationEmojiCatalog", () => {
  it("resolves the Yohta preset by logical name for the current application", async () => {
    const applicationId = "123456789012345678";
    const names = ["progressed", "progress", "yhota_run3", "yohta_stop", "canned_fish"];
    const emojis = new Map(names.map((name, index) => [
      String(200_000_000_000_000_000n + BigInt(index)),
      {
        id: String(200_000_000_000_000_000n + BigInt(index)),
        name,
        animated: name === "yhota_run3" || name === "canned_fish",
      },
    ]));
    const catalog = new ApplicationEmojiCatalog(
      {
        application: {
          id: applicationId,
          emojis: { fetch: vi.fn().mockResolvedValue(emojis) },
        },
      } as never,
      { warn: vi.fn() } as never,
    );

    await catalog.initialize();

    const theme = catalog.getYohtaTheme();
    expect(theme?.playing.scope).toBe("application");
    expect(theme?.playing).toEqual(expect.objectContaining({
      name: "yhota_run3",
      applicationId,
      animated: true,
    }));
    expect(catalog.getMissingYohtaEmojiNames()).toEqual([]);
  });

  it("keeps the preset unavailable when an application emoji is missing", async () => {
    const warn = vi.fn();
    const catalog = new ApplicationEmojiCatalog(
      {
        application: {
          id: "123456789012345678",
          emojis: { fetch: vi.fn().mockResolvedValue(new Map()) },
        },
      } as never,
      { warn } as never,
    );

    await catalog.initialize();

    expect(catalog.getYohtaTheme()).toBeNull();
    expect(catalog.getMissingYohtaEmojiNames()).toContain("progressed");
    expect(warn).toHaveBeenCalledOnce();
  });
});
