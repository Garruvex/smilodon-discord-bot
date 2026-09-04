import type { MemoryEngine } from "../../memory/memory.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "./chat-tool.js";

interface MemoryLookupToolArgs {
  query: string;
  scope: "search" | "list";
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
// "list" also passes onlySelfPrivateMemories, which narrows recall()'s
// candidate set itself (audience "private", owner AND subject both the
// caller) before it ranks or spends its character budget — not a filter
// applied here afterward. That ordering matters: a private note about
// someone else, or unrelated guild/channel knowledge (recall()'s
// subjectIds param only *boosts* results about the current user, it
// doesn't filter out the rest), can rank higher than the caller's own
// memories and consume the whole budget — a broad "what do you remember
// about me" (no topical requirement to narrow anything down first) would
// then have nothing of the caller's own left to return, even discarding
// perfectly afterward. "search" doesn't need either restriction:
// requireTopicalMatch already keeps guild knowledge relevant to the query,
// and a private note about someone else is a legitimate hit for a query
// specifically about them.
export class MemoryLookupTool implements ChatTool<MemoryLookupToolArgs> {
  public readonly name = "lookup_memory";
  public readonly description =
    "Searches the current user's remembered facts and this guild's confirmed knowledge, beyond what's already " +
    "been included in context. Use when asked what you remember about something.";
  public readonly parameters = {
    type: "object",
    additionalProperties: false,
    required: ["query", "scope"],
    properties: {
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
          "request like \"what do you remember about me\" — returns everything stored about the current user " +
          "specifically (not guild knowledge about others), most relevant/recent first, without requiring it " +
          "to match `query`.",
      },
    },
  };

  public constructor(private readonly memoryEngine: MemoryEngine) {}

  public async execute(args: MemoryLookupToolArgs, ctx: ChatToolContext): Promise<ChatToolResult> {
    const query = args.query.trim();
    const isList = args.scope === "list";
    if (!isList && !query) return { content: "Empty search query." };
    const { memories } = await this.memoryEngine.recall({
      guildId: ctx.guildId, channelId: ctx.channelId, userId: ctx.currentUser.id,
      message: query, recentHistory: [], subjectIds: [ctx.currentUser.id], now: Date.now(),
      channelMode: ctx.channelMode, requireTopicalMatch: !isList, onlySelfPrivateMemories: isList,
    });
    // In list mode, recall() has already narrowed `memories` to exactly
    // the caller's own private memories about themselves (see
    // onlySelfPrivateMemories above) — no further filtering needed here.
    // Not sliced to maxResultsPerSource: the tool description promises
    // "everything stored", and recall() already bounds the result set by
    // its own character budget (maxSelectedChars), not by count — slicing
    // to 10 here would silently drop real memories once a user has more
    // than that, recreating the exact under-remembering perception this
    // system exists to fix. "search" mode below still slices, since a
    // targeted query returning its 11th-most-relevant guild fact is a
    // reasonable place to stop.
    const userMemories = memories.filter((memory) => memory.audience === "private")
      .map((memory) => ({ topic: memory.topic, slot: memory.slot, statement: memory.statement }));
    const guildKnowledge = isList
      ? []
      : memories.filter((memory) => memory.audience !== "private").slice(0, maxResultsPerSource)
          .map((memory) => ({ topic: memory.topic, slot: memory.slot, statement: memory.statement }));
    if (userMemories.length === 0 && guildKnowledge.length === 0) {
      return { content: "No matching memories or guild knowledge found." };
    }
    return { content: JSON.stringify({ userMemories, guildKnowledge }) };
  }
}
