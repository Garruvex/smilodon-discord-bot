import { describe, expect, it } from "vitest";

import { resolveChannelMemoryMode, resolveMemoryScope } from "../../src/application/memory/memory-channel-policy.js";

describe("resolveChannelMemoryMode", () => {
  it("defaults unlisted channels to shared", () => {
    expect(resolveChannelMemoryMode({}, "general")).toBe("shared");
  });

  it("honors an explicit override", () => {
    expect(resolveChannelMemoryMode({ dnd: "isolated" }, "dnd")).toBe("isolated");
    expect(resolveChannelMemoryMode({ dnd: "isolated" }, "general")).toBe("shared");
  });
});

describe("resolveMemoryScope", () => {
  it("shared mode trusts the model's channelScoped flag for guild-audience proposals", () => {
    expect(resolveMemoryScope("shared", "general", { audience: "guild", channelScoped: false }))
      .toEqual({ audience: "guild", channelId: null, isolationChannelId: null });
    expect(resolveMemoryScope("shared", "general", { audience: "guild", channelScoped: true }))
      .toEqual({ audience: "channel", channelId: "general", isolationChannelId: null });
  });

  it("shared mode resolves public person facts to guild audience", () => {
    expect(resolveMemoryScope("shared", "general", { audience: "private", channelScoped: false }, true))
      .toEqual({ audience: "guild", channelId: null, isolationChannelId: null });
  });

  it("isolated mode force-scopes a guild-audience proposal to the channel regardless of the model's flag", () => {
    expect(resolveMemoryScope("isolated", "dnd", { audience: "guild", channelScoped: false }))
      .toEqual({ audience: "channel", channelId: "dnd", isolationChannelId: "dnd" });
    expect(resolveMemoryScope("isolated", "dnd", { audience: "guild", channelScoped: true }))
      .toEqual({ audience: "channel", channelId: "dnd", isolationChannelId: "dnd" });
  });

  it("isolated mode shares person facts within the source channel only", () => {
    expect(resolveMemoryScope("isolated", "dnd", { audience: "private", channelScoped: false }, true))
      .toEqual({ audience: "channel", channelId: "dnd", isolationChannelId: "dnd" });
  });
});
