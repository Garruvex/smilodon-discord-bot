import type { CharacterModule, CharacterTurn } from "../character-module-registry.js";
import type { ChatResponse, PersonalMemoryExtractionAction } from "../chat-provider.js";
import type { CharacterModuleServices } from "./shared.js";
import { z } from "zod";
import { resolveChannelMemoryMode } from "../../memory/memory-channel-policy.js";
import { serious, personaFingerprint } from "./shared.js";
import { buildPersonalMemoryExtractionPrompt, personalMemoryExtractionJsonSchema, personalMemoryExtractionSchema } from "../personal-memory-extraction.js";
const canonFactSchema = z.object({ slot: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u).max(60), statement: z.string().min(1).max(200), quote: z.string().min(1).max(400), consistent: z.boolean() });
const combinedSchema = personalMemoryExtractionSchema.extend({ facts: z.array(canonFactSchema).max(2) });
const combinedJsonSchema: Record<string, unknown> = { ...personalMemoryExtractionJsonSchema, required: ["actions", "facts"], properties: { ...personalMemoryExtractionJsonSchema.properties, facts: {
  type: "array", maxItems: 2, items: { type: "object", additionalProperties: false, required: ["slot", "statement", "quote", "consistent"], properties: {
    slot: { type: "string" }, statement: { type: "string" }, quote: { type: "string" }, consistent: { type: "boolean" },
  } },
} } };
// A conservative local guard for common polarity contradictions across slots.
// Global semantic consistency is also requested explicitly in the combined pass.
export function canonContradiction(left: string, right: string): boolean {
  const polarity = (text: string): boolean => /dislike|hate|do not like|don't like|never|not |不喜歡|討厭|嫌い/iu.test(text);
  const words = (text: string): Set<string> => new Set([...new Intl.Segmenter("zh", { granularity: "word" }).segment(text.toLowerCase().replace(/dislikes?|hates?|likes?|loves?|do not|don't|never|not |不喜歡|喜歡|討厭|嫌い|好き/giu, " "))].filter((part) => part.isWordLike && !["i", "a", "the", "我", "は", "が", "です"].includes(part.segment)).map((part) => part.segment));
  if (polarity(left) === polarity(right)) return false;
  const leftWords = words(left); const rightWords = words(right);
  return [...leftWords].some((word) => rightWords.has(word));
}
export class CanonModule implements CharacterModule {
  public readonly id = "canon";
  public constructor(private readonly services: CharacterModuleServices) {}
  public async contributeContext(turn: CharacterTurn): Promise<string | null> {
    const rows = await this.services.memory.read(this.services.profile(turn), this.services.query(turn), "canon", personaFingerprint(turn.request), turn.request.message);
    return rows.length ? JSON.stringify(rows.map((row) => ({ statement: row.statement, updatedAt: row.updatedAt }))) : null;
  }
  public async extractMemories(userMessage: string, reply: ChatResponse, turn: CharacterTurn): Promise<readonly PersonalMemoryExtractionAction[] | null> {
    if (!this.services.hasUtility || turn.settings.modules.canon.freeze || !reply.text || serious(turn.request.message)) return null;
    // A guild-wide identity must not publish character observations learned
    // in an isolated/session-only channel. Owner-authored lore still wins.
    if (resolveChannelMemoryMode(this.services.profile(turn).chat.channelMemoryModes, turn.request.channelId) !== "shared") return null;
    const old = await this.services.memory.read(this.services.profile(turn), this.services.query(turn), "canon", personaFingerprint(turn.request));
    const prompt = buildPersonalMemoryExtractionPrompt(userMessage, reply.text, turn.request.currentUser) +
      "\nAlso extract at most two stable fictional SELF-descriptions from confirmed character reply text, separately as facts. Never write member facts into character canon or use character speech as evidence of personal memory. Check each against ALL existing canon regardless of slot, and personality/lore. consistent=false for any contradiction or uncertainty; return no unsupported facts. Each quote must be verbatim. Data: " +
      JSON.stringify({ personality: turn.request.personality, lore: turn.request.personaLore, canon: old.map((row) => row.statement), confirmedMessages: reply.characterDeliveryProof ?? [] }).replaceAll("<", "\\u003c");
    const output = combinedSchema.safeParse(await this.services.generate(prompt, combinedJsonSchema));
    if (!output.success) return [];
    if (!this.services.ready(turn, "canon")) return output.data.actions;
    const comparisons = old.map((record) => ({ slot: record.slot, statement: record.statement }));
    const names = [turn.request.currentUser, ...turn.request.mentionedUsers].flatMap((user) => [user.id, user.displayName]).filter((name) => name.length > 1);
    for (const fact of output.data.facts) {
      if (!fact.consistent || !reply.text.includes(fact.quote) || names.some((name) => fact.statement.includes(name))) continue;
      if (comparisons.some((record) => (record.slot === fact.slot && record.statement !== fact.statement) || canonContradiction(record.statement, fact.statement))) continue;
      const proof = reply.characterDeliveryProof?.find((message) => message.content.includes(fact.quote));
      if (!proof) continue;
      const written = await this.services.memory.write(this.services.profile(turn), turn.request.channelId, "canon", { ...this.services.base(turn, fact.slot, fact.statement),
        sourceQuote: fact.quote, sourceMessageId: proof?.messageId ?? null, sourceChannelId: proof ? turn.request.channelId : null });
      if (written) comparisons.push({ slot: written.slot, statement: written.statement });
    }
    return output.data.actions;
  }
}
