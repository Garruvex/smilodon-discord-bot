import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchLinkContentMock = vi.fn();
const fetchXPostMock = vi.fn();
const isXPostUrlMock = vi.fn();

vi.mock("../../src/infrastructure/net/safe-url-fetch.js", () => ({
  fetchLinkContent: (...args: unknown[]): unknown => fetchLinkContentMock(...args),
}));
vi.mock("../../src/infrastructure/net/x-post-fetch.js", () => ({
  fetchXPost: (...args: unknown[]): unknown => fetchXPostMock(...args),
  isXPostUrl: (...args: unknown[]): unknown => isXPostUrlMock(...args),
}));

const { ReadLinkTool } = await import("../../src/application/chat/tools/read-link-tool.js");
import type { ChatToolContext } from "../../src/application/chat/tools/chat-tool.js";

function fakeContext(signal?: AbortSignal): ChatToolContext {
  return {
    guildId: "g1",
    channelId: "c1",
    currentUser: { id: "u1", displayName: "User" } as never,
    channelIsNsfw: false,
    isOwner: false,
    music: null,
    pendingGeneratedImages: [],
    ...(signal ? { signal } : {}),
  };
}

describe("ReadLinkTool", () => {
  beforeEach(() => {
    fetchLinkContentMock.mockReset();
    fetchXPostMock.mockReset();
    isXPostUrlMock.mockReset();
  });

  it("exposes a single required url parameter", () => {
    const tool = new ReadLinkTool();
    expect(tool.name).toBe("read_link");
    expect(tool.parameters).toMatchObject({ required: ["url"], additionalProperties: false });
  });

  it("routes X/Twitter URLs to fetchXPost", async () => {
    isXPostUrlMock.mockReturnValue(true);
    fetchXPostMock.mockResolvedValue({ ok: true, finalUrl: "https://x.com/a/status/1", text: "tweet text" });
    const tool = new ReadLinkTool();
    const result = await tool.execute({ url: "https://x.com/a/status/1" }, fakeContext());
    expect(fetchXPostMock).toHaveBeenCalled();
    expect(fetchLinkContentMock).not.toHaveBeenCalled();
    expect(result.content).toContain("tweet text");
  });

  it("routes other URLs to fetchLinkContent", async () => {
    isXPostUrlMock.mockReturnValue(false);
    fetchLinkContentMock.mockResolvedValue({ ok: true, finalUrl: "https://example.com/", text: "page text" });
    const tool = new ReadLinkTool();
    const result = await tool.execute({ url: "https://example.com/" }, fakeContext());
    expect(fetchLinkContentMock).toHaveBeenCalled();
    expect(fetchXPostMock).not.toHaveBeenCalled();
    expect(result.content).toContain("page text");
  });

  it("never throws and returns a content string on failure", async () => {
    isXPostUrlMock.mockReturnValue(false);
    fetchLinkContentMock.mockResolvedValue({ ok: false, reason: "the request failed or timed out." });
    const tool = new ReadLinkTool();
    const result = await tool.execute({ url: "https://example.com/" }, fakeContext());
    expect(result.content).toMatch(/Could not read that link/);
  });

  it("passes ctx.signal through when present", async () => {
    isXPostUrlMock.mockReturnValue(false);
    fetchLinkContentMock.mockResolvedValue({ ok: true, finalUrl: "https://example.com/", text: "x" });
    const controller = new AbortController();
    const tool = new ReadLinkTool();
    await tool.execute({ url: "https://example.com/" }, fakeContext(controller.signal));
    expect(fetchLinkContentMock).toHaveBeenCalledWith("https://example.com/", { signal: controller.signal });
  });
});
