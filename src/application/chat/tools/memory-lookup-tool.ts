import type { MemoryEngine } from "../../memory/memory.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "./chat-tool.js";

interface MemoryLookupToolArgs {
  query: string;
}

const maxResultsPerSource = 10;

// Looks beyond what's already been relevance-selected into the prompt (see
// MemoryEngine.recall, called for every turn) — for when the model needs to
// explicitly answer "what do you remember about X" rather than relying on
// whatever was ambiently included for this turn. Reuses recall() itself
// (its BM25/RRF ranking against the query text is a better match signal
// than a plain substring scan) and then filters the ranked result down to
// entries that actually mention the needle, for precision.
export class MemoryLookupTool implements ChatTool<MemoryLookupToolArgs> {
  public readonly name = "lookup_memory";
  public readonly description =
    "Searches the current user's remembered facts and this guild's confirmed knowledge for a keyword or topic, " +
    "beyond what's already been included in context. Use when asked what you remember about something.";
  public readonly parameters = {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", description: "Keyword or topic to search for." },
    },
  };

  public constructor(private readonly memoryEngine: MemoryEngine) {}

  public async execute(args: MemoryLookupToolArgs, ctx: ChatToolContext): Promise<ChatToolResult> {
    const needle = args.query.trim().toLowerCase();
    if (!needle) return { content: "Empty search query." };
    const { memories } = await this.memoryEngine.recall({
      guildId: ctx.guildId, channelId: ctx.channelId, userId: ctx.currentUser.id,
      message: args.query, recentHistory: [], subjectIds: [ctx.currentUser.id], now: Date.now(),
    });
    const matches = memories.filter((memory) =>
      memory.topic.toLowerCase().includes(needle) ||
      memory.slot.toLowerCase().includes(needle) ||
      memory.statement.toLowerCase().includes(needle));
    const userMemories = matches.filter((memory) => memory.audience === "private").slice(0, maxResultsPerSource)
      .map((memory) => ({ topic: memory.topic, slot: memory.slot, statement: memory.statement }));
    const guildKnowledge = matches.filter((memory) => memory.audience !== "private").slice(0, maxResultsPerSource)
      .map((memory) => ({ topic: memory.topic, slot: memory.slot, statement: memory.statement }));
    if (userMemories.length === 0 && guildKnowledge.length === 0) {
      return { content: "No matching memories or guild knowledge found." };
    }
    return { content: JSON.stringify({ userMemories, guildKnowledge }) };
  }
}
