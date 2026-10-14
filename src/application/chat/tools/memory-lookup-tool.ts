import type { Memory, MemoryEngine } from "../../memory/memory.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "./chat-tool.js";

interface MemoryLookupToolArgs {
  query: string;
  scope: "search" | "list";
  subjectUserId?: string | null;
}

const maxResultsPerSource = 10;

// Looks beyond what's already been relevance-selected into the prompt (see
// MemoryEngine.recall, called for every turn) — for when the model needs to
// explicitly answer "what do you remember about X" rather than relying on
// whatever was ambiently included for this turn.
//
// Two scopes, not one: "search" reuses recall()'s own BM25/embedding
// ranking and requires a genuine topical match (see
// MemoryRecallInput.requireTopicalMatch) — right for a targeted question
// ("what's my favorite fruit"). "list" skips that requirement entirely —
// right for a broad one ("what do you remember about me"), which by
// definition shares no particular topic with most of what's stored and
// would otherwise come back empty even though there's plenty on file. A
// single scope tuned for one of these always fails the other: requiring a
// topical match starves broad requests, and not requiring one (the
// previous, single-scope version of this tool) turns an unrelated query
// into apparent matches purely off recency/subject boost.
//
// Self-list mode narrows candidates by canonical subject before ranking
// and budgeting, across authorized private/channel/guild audiences.
// Explicit other-person lookup uses filterSubjectIds; subjectIds alone
// only boosts ranking. Caller permissions remain authoritative in both.
export class MemoryLookupTool implements ChatTool<MemoryLookupToolArgs> {
  public readonly outputKind = "context" as const;
  public readonly name = "lookup_memory";
  public readonly description =
    "Searches the current user's remembered facts and this guild's confirmed knowledge, beyond what's already " +
    "been included in context. Use when asked what you remember about something.";
  public readonly parameters = {
    type: "object",
    additionalProperties: false,
    required: ["query", "scope", "subjectUserId"],
    properties: {
      subjectUserId: { type: ["string", "null"], description: "A supplied canonical member ID for a targeted person lookup; null for ordinary search or a self inventory. Never guess an ID from an ambiguous name." },
      query: {
        type: "string",
        description: "Keyword or topic to search for. Ignored (may be empty) when scope is \"list\".",
      },
      scope: {
        type: "string",
        enum: ["search", "list"],
        description:
          "\"search\" for a specific topic/keyword (e.g. \"favorite fruit\") — only genuinely related results " +
          "are returned, from both the current user's own memories and guild knowledge. \"list\" for a broad " +
          "request like \"what do you remember about me\" — returns eligible subject facts within the recall budget " +
          "(not unrelated guild facts), most relevant/recent first, without requiring it " +
          "to match `query`.",
      },
    },
  };

  public constructor(private readonly memoryEngine: MemoryEngine) {}

  public async execute(args: MemoryLookupToolArgs, ctx: ChatToolContext): Promise<ChatToolResult> {
    const query = args.query.trim();
    const isList = args.scope === "list";
    const subjectId = args.subjectUserId ?? ctx.currentUser.id;
    if (args.subjectUserId && subjectId !== ctx.currentUser.id && !ctx.knownSubjectIds?.includes(subjectId))
      return { content: "That person was not resolved to a supplied account ID. Ask for a Discord mention or clarification." };
    if (!isList && !query) return { content: "Empty search query." };
    const { memories } = await this.memoryEngine.recall({
      guildId: ctx.guildId, channelId: ctx.channelId, userId: ctx.currentUser.id,
      message: query, recentHistory: [], subjectIds: [subjectId], now: Date.now(),
      ...(args.subjectUserId ? { filterSubjectIds: [subjectId] } : {}),
      channelMode: ctx.channelMode, requireTopicalMatch: !isList, onlySelfSubjectMemories: isList && subjectId === ctx.currentUser.id,
    });
    // List results are subject-scoped and bounded by recall's character
    // budget; they are not a promise of an exhaustive inventory. Search
    // additionally caps community facts by count.
    const render = (memory: Memory): Record<string, unknown> => ({
      id: memory.id, subjectType: memory.subjectType, subjectId: memory.subjectId, audience: memory.audience,
      topic: memory.topic, slot: memory.slot, statement: memory.statement,
      status: memory.status, updatedAt: memory.updatedAt,
    });
    const userMemories = memories.filter((memory) => memory.subjectType === "member" && (!isList || memory.subjectId === subjectId))
      .map(render);
    const guildKnowledge = isList
      ? []
      : memories.filter((memory) => memory.subjectType !== "member").slice(0, maxResultsPerSource).map(render);
    if (userMemories.length === 0 && guildKnowledge.length === 0) {
      return { content: "No matching memories or guild knowledge found." };
    }
    return { content: JSON.stringify({ userMemories, guildKnowledge, boundedResults: true,
      scope: isList ? "eligible facts about the caller across audiences" : "eligible matching person/community facts",
      note: "Results respect visibility and the recall budget; this is not a promise of an exhaustive inventory." }) };
  }
}
