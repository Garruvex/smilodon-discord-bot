import type { ChatRequest, StructuredCallOptions } from "../chat/chat-provider.js";
import { consumeModelOperation, snapshotModelArguments, type UtilityOperation } from "./approved-model-operation.js";
import { requireApprovedModelReply } from "./approved-conversation-request.js";

const arity: Readonly<Record<UtilityOperation, number>> = Object.freeze({ generateCharacterData: 2, summarizeDroppedExchanges: 2,
  summarizeReplyChainOverflow: 1, extractPersonalMemories: 3, evolvePersonaDrift: 2, summarizeChannelMessages: 2,
  analyzeUserCustomization: 1, compilePersonaBundle: 1, classifyMemoryConflict: 2, generateReferenceImage: 2, verifyAttribution: 3 });

// Preserve absent capabilities and the raw receiver's private fields. Internal
// provider retries receive the pinned source check, never caller replacements.
export function guardModelTransport<T extends object>(provider: T): T {
  const wrappers = new Map<PropertyKey, unknown>();
  return new Proxy(provider, { get(target, key, receiver): unknown {
    const value: unknown = Reflect.get(target, key, receiver);
    if (key === "reply" && typeof value === "function") {
      if (!wrappers.has(key)) wrappers.set(key, async (request: ChatRequest, ...rest: unknown[]): Promise<unknown> => {
        requireApprovedModelReply(request); await request.beforeModelAttempt!();
        const result: unknown = await Reflect.apply(value, target, [request, ...rest]);
        await request.beforeModelAttempt!(); return result;
      });
      return wrappers.get(key);
    }
    if (typeof key !== "string" || !Object.hasOwn(arity, key) || typeof value !== "function") return value;
    if (!wrappers.has(key)) wrappers.set(key, async (...input: unknown[]): Promise<unknown> => {
      const method = key as UtilityOperation; const count = arity[method];
      const args = snapshotModelArguments(input.slice(0, count));
      const options = consumeModelOperation(method, args, input[count] as StructuredCallOptions | (() => Promise<void>) | undefined);
      await options.beforeAttempt!();
      const result: unknown = await Reflect.apply(value, target, [...args, method === "verifyAttribution" ? options.beforeAttempt : options]);
      await options.beforeAttempt!(); return result;
    });
    return wrappers.get(key);
  } });
}
