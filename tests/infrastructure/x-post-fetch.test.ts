import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchXPost, isXPostUrl } from "../../src/infrastructure/net/x-post-fetch.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]): Promise<unknown> => Promise.resolve(fetchMock(...args) as unknown));

function jsonResponse(status: number, body: unknown): unknown {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string): string | null => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    json: (): Promise<unknown> => Promise.resolve(body),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("isXPostUrl", () => {
  it.each([
    "https://x.com/someone/status/1234567890",
    "https://twitter.com/someone/status/1234567890",
    "https://mobile.twitter.com/someone/status/1234567890",
  ])("recognizes %s as a post link", (url) => {
    expect(isXPostUrl(url)).toBe(true);
  });

  it.each([
    "https://x.com/someone",
    "https://example.com/someone/status/123",
    "not a url",
  ])("rejects %s", (url) => {
    expect(isXPostUrl(url)).toBe(false);
  });
});

describe("fetchXPost", () => {
  it("rejects a malformed user/id path", async () => {
    const result = await fetchXPost("https://x.com/a b/status/abc");
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses a successful vxtwitter response into a summary", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      text: "hello world",
      user_name: "Some User",
      user_screen_name: "someuser",
      likes: 5,
      retweets: 2,
    }));
    const result = await fetchXPost("https://x.com/someuser/status/1234567890");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("hello world");
      expect(result.text).toContain("Some User");
      expect(result.text).toContain("5 likes");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("api.vxtwitter.com");
  });

  it("falls back to fxtwitter when vxtwitter fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { text: "fallback text", user_screen_name: "someuser" }));
    const result = await fetchXPost("https://x.com/someuser/status/1234567890");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain("fallback text");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("api.fxtwitter.com");
  });

  it("returns a clean failure when both mirrors fail", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network error"));
    fetchMock.mockRejectedValueOnce(new Error("network error"));
    const result = await fetchXPost("https://x.com/someuser/status/1234567890");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/deleted|private|down/);
  });
});
