import { describe, expect, it } from "vitest";

import { formatBirthdayListPages } from "../../src/infrastructure/discord/commands/common/birthday-command.js";

describe("formatBirthdayListPages", () => {
  it("sorts saved birthdays by month, day, then user", () => {
    const pages = formatBirthdayListPages([
      { userId: "z", month: 12, day: 1 },
      { userId: "b", month: 1, day: 3 },
      { userId: "a", month: 1, day: 3 },
      { userId: "c", month: 1, day: 1 },
    ]);

    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("Server birthdays (4)");
    expect(pages[0]!.indexOf("<@c>")).toBeLessThan(pages[0]!.indexOf("<@a>"));
    expect(pages[0]!.indexOf("<@a>")).toBeLessThan(pages[0]!.indexOf("<@b>"));
    expect(pages[0]!.indexOf("<@b>")).toBeLessThan(pages[0]!.indexOf("<@z>"));
  });

  it("keeps every birthday when the list needs several Discord messages", () => {
    const records = Array.from({ length: 150 }, (_, index) => ({
      userId: `100000000000000${String(index).padStart(3, "0")}`, month: index % 12 + 1, day: 1,
    }));
    const pages = formatBirthdayListPages(records);

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.length <= 1_900)).toBe(true);
    for (const record of records) {
      expect(pages.join("\n")).toContain(`<@${record.userId}>`);
    }
  });
});
