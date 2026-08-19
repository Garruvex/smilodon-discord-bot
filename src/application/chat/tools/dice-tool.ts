import { rollDice } from "../../../domain/games/dice.js";
import type { ChatTool, ChatToolResult } from "./chat-tool.js";

interface DiceToolArgs {
  sides: number | null;
  count: number | null;
}

export class DiceRollTool implements ChatTool<DiceToolArgs> {
  public readonly name = "roll_dice";
  public readonly description =
    "Rolls one or more dice and returns the actual result. Use this whenever the user asks you to roll dice " +
    "(e.g. \"roll a d20\", \"roll 3d6\") instead of making up a number.";
  public readonly parameters = {
    type: "object",
    additionalProperties: false,
    required: ["sides", "count"],
    properties: {
      sides: { type: ["integer", "null"], description: "Sides per die. Null for the default of 6." },
      count: { type: ["integer", "null"], description: "Number of dice to roll. Null for the default of 1." },
    },
  };

  public execute(args: DiceToolArgs): Promise<ChatToolResult> {
    const sides = Math.min(Math.max(args.sides ?? 6, 2), 1_000);
    const count = Math.min(Math.max(args.count ?? 1, 1), 20);
    const { rolls, total } = rollDice(sides, count);
    return Promise.resolve({ content: JSON.stringify({ sides, count, rolls, total }) });
  }
}
