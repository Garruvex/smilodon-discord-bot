import { pickEightBallAnswer } from "../../../domain/games/eightball.js";
import type { ChatTool, ChatToolResult } from "./chat-tool.js";

interface EightBallToolArgs {
  question: string;
}

export class EightBallTool implements ChatTool<EightBallToolArgs> {
  public readonly name = "ask_eightball";
  public readonly description =
    "Asks the magic 8-ball a yes/no question and returns its actual random answer. Use this whenever the user " +
    "asks an 8-ball-style yes/no question instead of making up an answer.";
  public readonly parameters = {
    type: "object",
    additionalProperties: false,
    required: ["question"],
    properties: {
      question: { type: "string", description: "The yes/no question being asked." },
    },
  };

  public execute(args: EightBallToolArgs): Promise<ChatToolResult> {
    return Promise.resolve({ content: JSON.stringify({ question: args.question, answer: pickEightBallAnswer() }) });
  }
}
