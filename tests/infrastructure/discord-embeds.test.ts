import type { Embed, Message } from "discord.js";
import { describe, expect, it } from "vitest";
import { embedImageAssets, embedImageSource, messageLinkPreviews } from "../../src/infrastructure/discord/behaviors/discord-embeds.js";
import { guardedAssetsHash } from "../../src/application/chat/guarded-conversation-context.js";
import { linkPreviewText } from "../../src/application/chat/prompt-message.js";

const embed = (data: { type: string; url?: string; title?: string; description?: string; provider?: string; thumbnail?: string; image?: string }): Embed => ({
  data: { type: data.type }, url: data.url ?? null, title: data.title ?? null, description: data.description ?? null,
  provider: data.provider ? { name: data.provider } : null, author: null,
  thumbnail: data.thumbnail ? { url: "x", proxyURL: data.thumbnail } : null, image: data.image ? { url: "x", proxyURL: data.image } : null,
}) as unknown as Embed;
const message = (embeds: Embed[], bot = false): Message => ({ author: { bot }, embeds }) as unknown as Message;

describe("Discord link previews", () => {
  it("turns unfurls into bounded previews and proxied images", () => {
    const source = message([
      embed({ type: "article", url: "https://news.example/a", provider: "News", title: "Big  story", description: "x".repeat(500),
        thumbnail: "https://images-ext-1.discordapp.net/external/a/thumb.png" }),
      embed({ type: "gifv", url: "https://tenor.com/view/cat-dance-gif-1", provider: "Tenor", thumbnail: "https://images-ext-2.discordapp.net/external/b/cat.png?width=100" }),
      embed({ type: "video", url: "https://youtube.example/v", provider: "YouTube", title: "Clip", thumbnail: "https://images-ext-1.discordapp.net/external/c/max.jpg" }),
    ]);
    const previews = messageLinkPreviews(source);
    expect(previews.map((preview) => preview.title)).toEqual(["Big story", "GIF", "Clip"]);
    expect(previews[0]!.description!.length).toBe(300);
    expect(linkPreviewText(previews)).toMatch(/^News — Big story — x+…/u);
    // An article's small thumbnail is not loaded; GIF and video frames are, at most two.
    expect(embedImageAssets(source)).toEqual([{ id: "embed-1", contentType: "image/png", size: 8 * 1024 * 1024 }, { id: "embed-2", contentType: "image/jpeg", size: 8 * 1024 * 1024 }]);
    expect(embedImageSource(source, "embed-1")).toEqual({ url: "https://images-ext-2.discordapp.net/external/b/cat.png?width=100", contentType: "image/png" });
    expect(embedImageSource(source, "embed-0")).toBeNull();
  });
  it("ignores bot embeds and keeps preview images out of the asset hash", () => {
    const bot = message([embed({ type: "image", provider: "Imgur", thumbnail: "https://images-ext-1.discordapp.net/a.png" })], true);
    expect(messageLinkPreviews(bot)).toEqual([]); expect(embedImageAssets(bot)).toEqual([]);
    const attachment = { id: "1", contentType: "image/png", size: 10 };
    expect(guardedAssetsHash([attachment, { id: "embed-0", contentType: "image/png", size: 1 }])).toBe(guardedAssetsHash([attachment]));
  });
});
