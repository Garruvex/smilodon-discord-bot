import type { ChatTool } from "./chat-tool.js";

export class ChatToolRegistry {
  private readonly byName: ReadonlyMap<string, ChatTool>;

  public constructor(private readonly tools: readonly ChatTool[]) {
    this.byName = new Map(tools.map((tool) => [tool.name, tool]));
    if (this.byName.size !== tools.length) {
      const seen = new Set<string>();
      const duplicate = tools.find((tool) => {
        if (seen.has(tool.name)) return true;
        seen.add(tool.name);
        return false;
      });
      throw new Error(`Duplicate chat tool name "${duplicate?.name}" registered.`);
    }
  }

  public list(): readonly ChatTool[] {
    return this.tools;
  }

  public get(name: string): ChatTool | undefined {
    return this.byName.get(name);
  }
}
