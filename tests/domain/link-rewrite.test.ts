import { describe, expect, it } from "vitest";
import type { LinkFixPlatform } from "../../src/config/guild-configuration.js";
import { extractLinkRewrites } from "../../src/domain/links/link-rewrite.js";

const platforms = new Set<LinkFixPlatform>(["twitter", "threads", "tiktok", "instagram", "reddit", "bilibili"]);

describe("link rewrites", () => {
  it.each([
    ["https://www.bilibili.com/video/BV1xx411c7mD?p=2", "https://vxbilibili.com/video/BV1xx411c7mD?p=2"],
    ["https://m.bilibili.com/video/av2", "https://vxbilibili.com/video/av2"],
    ["https://www.bilibili.com/bangumi/play/ep123", "https://vxbilibili.com/bangumi/play/ep123"],
    ["https://b23.tv/AbCd12", "https://vxb23.tv/AbCd12"],
    ["https://www.reddit.com/r/test/comments/abc/title/", "https://vxreddit.com/r/test/comments/abc/title/"],
    ["https://old.reddit.com/r/test/comments/abc/title/", "https://vxreddit.com/r/test/comments/abc/title/"],
    ["https://redd.it/abc", "https://vxreddit.com/abc"],
    ["https://reddit.com/r/test/s/AbCd12", "https://vxreddit.com/r/test/s/AbCd12"],
    ["https://threads.com/@user/post/abc", "https://vxthreads.com/@user/post/abc"],
    ["https://vm.tiktok.com/AbCd12/", "https://tnktok.com/AbCd12/"],
  ])("rewrites %s", (originalUrl, rewrittenUrl) => {
    expect(extractLinkRewrites(originalUrl, platforms)).toEqual([expect.objectContaining({ originalUrl, rewrittenUrl })]);
  });

  it("honors independent Bilibili and Reddit toggles", () => {
    const content = "https://b23.tv/AbCd12 https://bilibili.com/video/av2 https://redd.it/abc";
    expect(extractLinkRewrites(content, new Set(["reddit"]))).toHaveLength(1);
    expect(extractLinkRewrites(content, new Set(["bilibili"]))).toHaveLength(2);
    expect(extractLinkRewrites(content, new Set())).toEqual([]);
  });

  it("removes tracking while preserving functional parameters", () => {
    const [match] = extractLinkRewrites("https://bilibili.com/video/av2?p=2&t=30&signature=keep&size=large&since=123&si=tracking&spm_id_from=share&utm_source=share", platforms);
    expect(match?.rewrittenUrl).toBe("https://vxbilibili.com/video/av2?p=2&t=30&signature=keep&size=large&since=123");
  });

  it("ignores proxy URLs and lookalike hosts", () => {
    expect(extractLinkRewrites("https://vxbilibili.com/video/av2 https://vxreddit.com/abc https://bilibili.com.example.org/video/av2", platforms)).toEqual([]);
  });
});
