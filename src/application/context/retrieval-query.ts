import { isGuardedContext, type GuardedConversationContext } from "../chat/guarded-conversation-context.js";
import { SocialOutputSuppressed } from "../chat/message-origin-store.js";
import { immutableSnapshot } from "./immutable-snapshot.js";

export interface GuardedRetrievalQuery { readonly kind: "model_tool_query" }
const toolQueries = new WeakMap<object, { context: GuardedConversationContext; text: string }>();

// Issuance belongs only to the reviewed executor, after source authorization.
export function toolRetrievalQuery(context: GuardedConversationContext, text: string): GuardedRetrievalQuery {
  if (!isGuardedContext(context) || text.length > 1000) throw new SocialOutputSuppressed();
  const receipt = Object.freeze({ kind: "model_tool_query" as const });
  toolQueries.set(receipt, { context, text: text.trim() }); return receipt;
}

export function retrievalProjection(context: GuardedConversationContext, query?: GuardedRetrievalQuery): {
  message: string; recentHistory: readonly { content: string }[]; replyToContent: string;
} {
  if (!isGuardedContext(context)) throw new SocialOutputSuppressed();
  if (query !== undefined) {
    const source = toolQueries.get(query);
    if (!source || source.context !== context) throw new SocialOutputSuppressed();
    return immutableSnapshot({ message: source.text, recentHistory: [], replyToContent: "" });
  }
  return immutableSnapshot({ message: context.current.content,
    recentHistory: context.retrievalHistory,
    replyToContent: context.replyChain.at(-1)?.content ?? "" });
}
