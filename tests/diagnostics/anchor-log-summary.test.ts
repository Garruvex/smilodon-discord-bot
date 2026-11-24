import { describe, expect, it } from "vitest";

import { summarizeAnchorLog } from "../../src/application/diagnostics/anchor-log-summary.js";

const coverage = (fields: Record<string, unknown>): string => JSON.stringify({ level: 30, time: 1_795_000_000_000, event: "context.guard.coverage", requested: 40, guildId: "g1", anchor: 0, ...fields });

describe("anchor log summary", () => {
  it("counts where follow-up referents were and how often the anchor added them", () => {
    const summary = summarizeAnchorLog([
      coverage({ anchorMatch: "beyond", anchor: 2, time: 1_795_000_100_000 }),
      coverage({ anchorMatch: "beyond" }),
      coverage({ anchorMatch: "window", guildId: "g2" }),
      coverage({ anchorMatch: "none" }),
      // The anchor was off for this turn, a bookkeeping read asked for no history, and noise is skipped.
      coverage({}),
      coverage({ anchorMatch: "beyond", requested: 0 }),
      "not json context.guard.coverage", JSON.stringify({ event: "chat.turn.completed" }),
    ]);
    expect(summary).toMatchObject({ turns: 5, observed: 4, none: 1, window: 1, beyond: 2, anchored: 1, beyondRate: 0.5,
      byGuild: { g1: { observed: 3, beyond: 2, anchored: 1 }, g2: { observed: 1, beyond: 0, anchored: 0 } }, firstAt: 1_795_000_000_000, lastAt: 1_795_000_100_000 });
  });

  it("reports no rate without observations", () => {
    expect(summarizeAnchorLog([coverage({})]).beyondRate).toBeNull();
  });
});
