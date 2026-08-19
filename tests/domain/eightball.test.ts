import { describe, expect, it } from "vitest";

import { eightBallAnswers, pickEightBallAnswer } from "../../src/domain/games/eightball.js";

describe("pickEightBallAnswer", () => {
  it("always returns one of the known answers", () => {
    for (let i = 0; i < 50; i++) {
      expect(eightBallAnswers).toContain(pickEightBallAnswer());
    }
  });
});
