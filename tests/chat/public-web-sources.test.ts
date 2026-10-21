import { describe, expect, it } from "vitest";
import { publicWebSources } from "../../src/application/chat/public-web-sources.js";

describe("public web citation boundary", () => {
  it("drops malformed, credential-bearing, local and private Discord citation URLs", () => {
    const urls = ["broken", "file:///secret", "javascript:alert(1)", "https://user:password@example.com/", "http://localhost/",
      "http://127.0.0.1/", "http://[::1]/", "http://service.internal/", "https://discord.com/channels/1/2/3",
      "https://canary.discord.com/channels/1/2/3", "https://docs.example.com/reference"];
    expect(publicWebSources(urls.map((url) => ({ url, title: "Source" })))).toEqual([{ url: urls.at(-1), title: "Source" }]);
  });
  it("deduplicates and bounds public citations", () => {
    const source = { url: "https://example.com/", title: "x".repeat(400) };
    const result = publicWebSources([source, source, ...Array.from({ length: 20 }, (_, index) => ({ url: `https://example.com/${index}`, title: "Source" }))]);
    expect(result).toHaveLength(5); expect(result[0]?.title).toHaveLength(300);
  });
});
