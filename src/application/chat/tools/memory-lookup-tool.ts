import type { ChatStateStore } from "../chat-state-store.js";
import type { GuildKnowledgeStore } from "../guild-knowledge-store.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "./chat-tool.js";

interface MemoryLookupToolArgs {
  query: string;
}

const maxResultsPerSource = 10;

// Looks beyond what's already been relevance-selected into the prompt (see
// GuildMemorySelector/UserMemorySelector) — for when the model needs to
// explicitly answer "what do you remember about X" rather than relying on
// whatever was ambiently included for this turn.
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

  public constructor(
    private readonly stateStore: ChatStateStore,
    private readonly guildKnowledgeStore: GuildKnowledgeStore,
  ) {}

  public async execute(args: MemoryLookupToolArgs, ctx: ChatToolContext): Promise<ChatToolResult> {
    const needle = args.query.trim().toLowerCase();
    if (!needle) return { content: "Empty search query." };
    const [state, guildKnowledge] = await Promise.all([
      this.stateStore.load(ctx.guildId, ctx.currentUser.id, Date.now()),
      this.guildKnowledgeStore.loadConfirmed(ctx.guildId),
    ]);
    const matches = (haystack: { topic: string; slot: string; statement: string }): boolean =>
      haystack.topic.toLowerCase().includes(needle) ||
      haystack.slot.toLowerCase().includes(needle) ||
      haystack.statement.toLowerCase().includes(needle);
    const memories = state.memories.filter(matches).slice(0, maxResultsPerSource)
      .map((memory) => ({ topic: memory.topic, slot: memory.slot, statement: memory.statement }));
    const knowledge = guildKnowledge.filter(matches).slice(0, maxResultsPerSource)
      .map((record) => ({ topic: record.topic, slot: record.slot, statement: record.statement }));
    if (memories.length === 0 && knowledge.length === 0) {
      return { content: "No matching memories or guild knowledge found." };
    }
    return { content: JSON.stringify({ userMemories: memories, guildKnowledge: knowledge }) };
  }
}
