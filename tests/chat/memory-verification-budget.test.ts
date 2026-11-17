import { describe, expect, it } from "vitest";
import { contextualTurnLimits, memoryVerificationBudgetMs, memoryVerificationLimits } from "../../src/application/chat/turn-work-budget.js";

describe("memory verification budget", () => {
  it("keeps the short budget for optional turns", () => {
    expect(memoryVerificationBudgetMs("group_conversation", 0, 30_000)).toBe(memoryVerificationLimits.optionalMs);
    expect(memoryVerificationBudgetMs("implicit_followup", 0)).toBe(memoryVerificationLimits.optionalMs);
  });

  it("bounds addressed turns instead of letting memory checks use the whole deadline", () => {
    expect(memoryVerificationBudgetMs("direct_mention", 0, 30_000)).toBe(memoryVerificationLimits.addressedMs);
    expect(memoryVerificationBudgetMs("explicit_reply", 0)).toBe(memoryVerificationLimits.addressedMs);
  });

  it("always leaves the generation reserve before an addressed turn's deadline", () => {
    const deadlineAt = 30_000;
    const now = deadlineAt - contextualTurnLimits.generationReserveMs - 2_000;
    expect(memoryVerificationBudgetMs("direct_mention", now, deadlineAt)).toBe(2_000);
    expect(memoryVerificationBudgetMs("direct_mention", deadlineAt - 1_000, deadlineAt)).toBe(0);
  });
});
