import type { ChatTool } from "./chat-tool.js";

export class ChatToolRegistry {
  private readonly byName: ReadonlyMap<string, ChatTool>;

  public constructor(private readonly tools: readonly ChatTool[]) {
    this.byName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  public list(): readonly ChatTool[] {
    return this.tools;
  }

  public get(name: string): ChatTool | undefined {
    return this.byName.get(name);
  }
}
