import { describe, expect, it } from "vitest";

import { exampleExchangeLimits, parseExampleExchanges } from "../../src/application/chat/example-exchange.js";

describe("parseExampleExchanges", () => {
  it("parses a multi-block file with tags and multi-line replies", () => {
    const content = `### Example
Tags: exam, school, venting
User: 我今天期中考炸了
Character: 草ww 哪科啦

### Example
User: 統計
Character: 喔那合理（
到底是計算炸掉還是看到題目直接大腦關機`;

    const result = parseExampleExchanges(content);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.exchanges).toEqual([
      { tags: "exam, school, venting", user: "我今天期中考炸了", character: "草ww 哪科啦" },
      { tags: "", user: "統計", character: "喔那合理（\n到底是計算炸掉還是看到題目直接大腦關機" },
    ]);
  });

  it("rejects a block missing a User: line, naming the example index", () => {
    const content = `### Example\nCharacter: hi there`;
    const result = parseExampleExchanges(content);
    expect(result).toEqual({ error: 'Example #1: missing a "User:" line.' });
  });

  it("rejects a block missing a Character: line", () => {
    const content = `### Example\nUser: hi there`;
    const result = parseExampleExchanges(content);
    expect(result).toEqual({ error: 'Example #1: missing a "Character:" line.' });
  });

  it("rejects a block with empty User text", () => {
    const content = `### Example\nUser:   \nCharacter: hi`;
    const result = parseExampleExchanges(content);
    expect(result).toEqual({ error: 'Example #1: "User:" text is empty.' });
  });

  it("names the correct index when a later block is malformed", () => {
    const content = `### Example\nUser: a\nCharacter: b\n\n### Example\nUser: c`;
    const result = parseExampleExchanges(content);
    expect(result).toEqual({ error: 'Example #2: missing a "Character:" line.' });
  });

  it("rejects a file with no example blocks", () => {
    const result = parseExampleExchanges("just some prose, no headings");
    expect(result).toEqual({ error: 'No "### Example" blocks found.' });
  });

  it("rejects a file exceeding the example count limit", () => {
    const blocks = Array.from(
      { length: exampleExchangeLimits.maxExamples + 1 },
      (_, i) => `### Example\nUser: u${i}\nCharacter: c${i}`,
    ).join("\n\n");
    const result = parseExampleExchanges(blocks);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/Too many examples/);
  });
});
