import { describe, expect, it } from "vitest";

import { ChatToolRegistry } from "../../src/application/chat/tools/chat-tool-registry.js";
import type { ChatTool } from "../../src/application/chat/tools/chat-tool.js";

function tool(name: string): ChatTool {
  return {
    name,
    description: "test tool",
    parameters: {},
    execute: () => Promise.resolve({ ok: true }) as never,
  };
}

describe("ChatToolRegistry", () => {
  it("looks up tools by name and lists all of them", () => {
    const registry = new ChatToolRegistry([tool("a"), tool("b")]);
    expect(registry.get("a")?.name).toBe("a");
    expect(registry.list()).toHaveLength(2);
  });

  it("throws on construction when two tools share a name", () => {
    expect(() => new ChatToolRegistry([tool("dice"), tool("dice")])).toThrow(/duplicate/i);
  });
});
