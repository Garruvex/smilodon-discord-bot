import { z } from "zod";
import { contributionLabels, type CharacterDecision } from "./character-decision.js";
import type { ChannelHistoryMessage, ConversationEvent } from "./chat-provider.js";

export const contextualDecisionWireRevision = 4;
export type ContextualExchangeLink = { kind: "speaker_exchange" | "bot_reference"; humanEventId: string; botEventId: string } |
  { kind: "reaction"; botEventId: string; actorIds: readonly string[] };
export interface ContextualInterpretation {
  version: "contextual_v1";
  relationship: "followup" | "group" | "elsewhere" | "unclear";
  intent: "answer" | "clarify" | "social" | "closing" | "contribute" | "abstain";
  action: "reply" | "react" | "silent";
  referent: "self_contained" | "context_linked" | "unresolved";
  link: ContextualExchangeLink | null;
}

// The wire contract has no Discord destination/author fields. Fixed bindings
// have no target choice; group choices use opaque per-call keys.
export function contextualDecisionContract(events: readonly ChannelHistoryMessage[], botId: string, fixedTarget: string | null,
  reaction?: Extract<ConversationEvent, { type: "reaction_snapshot" }>): {
  schema: Record<string, unknown>; targets: readonly { key: string; eventId: string }[];
  links: readonly { key: string; link: ContextualExchangeLink }[];
  evidenceSources: readonly { key: string; eventId: string }[]; parse: (raw: unknown) => CharacterDecision;
} {
  const evidenceSources = events.map((event, index) => ({ key: /^\d+$/u.test(event.messageId) ? `event_${index + 1}` : event.messageId, eventId: event.messageId }));
  const humans = events.filter((event) => event.authorId !== botId && event.author?.kind !== "bot");
  const candidates = reaction ? events.filter((event) => event.messageId === reaction.targetMessageId && event.authorId === botId && reaction.targetAuthorId === botId && fixedTarget === reaction.targetMessageId) : fixedTarget ? humans.filter((event) => event.messageId === fixedTarget) : humans.filter((event) =>
    !events.some((reply) => reply.authorId === botId && reply.replyToMessageId === event.messageId));
  const targets = candidates.map((event, index) => ({ key: `candidate_${index + 1}`, eventId: event.messageId }));
  const current = events.find((event) => event.messageId === fixedTarget) ?? events.at(-1);
  const links: { key: string; link: ContextualExchangeLink }[] = [];
  if (reaction && candidates.length) links.push({ key: "reaction", link: { kind: "reaction", botEventId: reaction.targetMessageId,
    actorIds: [...new Set(reaction.reactions.flatMap((item) => item.actorIds))] } });
  else for (const bot of events.filter((event) => event.authorId === botId && event.timestampMs < (current?.timestampMs ?? Infinity))) {
    const human = humans.find((event) => event.messageId === bot.replyToMessageId && event.authorId === bot.replyToAuthorId && event.timestampMs < bot.timestampMs);
    if (!human) continue;
    const kind = human.authorId === current?.authorId ? "speaker_exchange" : "bot_reference";
    const prefix = kind === "speaker_exchange" ? "speaker" : "reference";
    links.push({ key: `${prefix}_${links.filter((item) => item.link.kind === kind).length + 1}`, link: { kind, humanEventId: human.messageId, botEventId: bot.messageId } });
  }
  const probability = z.number().min(0).max(1);
  const shortText = z.string().superRefine((text, context) => {
    if ([...text].length > 200) context.addIssue({ code: "too_big", type: "string", maximum: 200, inclusive: true });
  });
  const contribution = z.object({ text: shortText, adds: shortText, label: z.enum(contributionLabels), motivation: probability }).strict();
  const validator = z.object({
    relationship: z.enum(["followup", "group", "elsewhere", "unclear"]),
    intent: z.enum(["answer", "clarify", "social", "closing", "contribute", "abstain"]), action: z.enum(["reply", "react", "silent"]),
    referent: z.enum(["self_contained", "context_linked", "unresolved"]),
    linkKey: z.string().nullable(),
    recipientEvidence: z.array(z.string()).max(5), recipientConfidence: probability, confidence: probability,
    opening: z.enum(["clear", "closed", "unclear"]), contribution: contribution.nullable(), reaction: z.string().nullable(),
    ...(!fixedTarget ? { targetKey: z.string().nullable() } : {}),
  }).strict();
  const probabilityJson = { type: "number", minimum: 0, maximum: 1 };
  const properties = {
    relationship: { type: "string", enum: ["followup", "group", "elsewhere", "unclear"] },
    intent: { type: "string", enum: ["answer", "clarify", "social", "closing", "contribute", "abstain"] },
    action: { type: "string", enum: ["reply", "react", "silent"] },
    referent: { type: "string", enum: ["self_contained", "context_linked", "unresolved"] },
    linkKey: { type: ["string", "null"], enum: [null, ...links.map((item) => item.key)] },
    recipientEvidence: { type: "array", items: { type: "string", enum: [...new Set(evidenceSources.map((source) => source.key))] }, maxItems: 5 },
    recipientConfidence: probabilityJson, confidence: probabilityJson,
    opening: { type: "string", enum: ["clear", "closed", "unclear"] }, reaction: { type: ["string", "null"] },
    contribution: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false,
      required: ["text", "adds", "label", "motivation"], properties: {
        text: { type: "string", maxLength: 200 }, adds: { type: "string", maxLength: 200 },
        label: { type: "string", enum: contributionLabels }, motivation: probabilityJson,
      } }] },
    ...(!fixedTarget ? { targetKey: { type: ["string", "null"], enum: [null, ...targets.map((target) => target.key)] } } : {}),
  };
  return { schema: { type: "object", additionalProperties: false, required: Object.keys(properties), properties }, targets, links, evidenceSources,
    parse: (raw): CharacterDecision => {
      const result = validator.parse(raw);
      const evidence = result.recipientEvidence.map((key) => evidenceSources.find((source) => source.key === key)?.eventId).filter((id): id is string => id !== undefined);
      if (evidence.length !== result.recipientEvidence.length) throw new ContextualContractError("invalid_evidence");
      const link = links.find((item) => item.key === result.linkKey)?.link ?? null;
      if (result.linkKey !== null && !link) throw new ContextualContractError("invalid_evidence");
      const targetId = fixedTarget ?? targets.find((target) => target.key === result.targetKey)?.eventId;
      const target = candidates.find((event) => event.messageId === targetId);
      if (!fixedTarget && result.targetKey !== null && !targets.some((item) => item.key === result.targetKey)) throw new ContextualContractError("invalid_target", "unknown_choice");
      if (result.action !== "silent" && !target) throw new ContextualContractError("invalid_target", fixedTarget ? "binding_missing" : "choice_required");
      if (result.action === "reply" && !result.contribution) throw new ContextualContractError("invalid_contribution");
      if (result.action !== "silent" && (reaction || result.relationship === "followup") && !link) throw new ContextualContractError("invalid_evidence");
      const linkedEvidence = link ? link.kind === "reaction" ? [link.botEventId] : [link.humanEventId, link.botEventId, target?.messageId ?? ""] : [];
      const resolvedEvidence = [...new Set([...evidence, ...linkedEvidence])];
      if (result.action !== "silent" && !resolvedEvidence.length) throw new ContextualContractError("invalid_evidence");
      return { addressing: result.relationship === "followup" ? "continuing" : result.relationship === "group" || result.relationship === "elsewhere" ? "others" : "unclear",
        motivation: result.contribution?.motivation ?? 0, recipientEvidence: resolvedEvidence, recipientConfidence: result.recipientConfidence,
        targetConfidence: result.confidence, confidence: result.confidence, opening: result.opening, boundary: "earlier", target: target?.messageId ?? "",
        contribution: { text: result.contribution?.text ?? "", adds: result.contribution?.adds ?? "", label: result.contribution?.label ?? "none",
          motivation: result.contribution?.motivation ?? 0, sourceMessageId: target?.messageId ?? "", recipientId: reaction ? "group" : target?.authorId ?? "group" },
        reaction: result.reaction, thoughts: [], contextual: { version: "contextual_v1", relationship: result.relationship, intent: result.intent, action: result.action, referent: result.referent, link } };
    } };
}
export class ContextualContractError extends Error {
  public constructor(public readonly failure: "invalid_target" | "invalid_evidence" | "invalid_contribution",
    public readonly targetFailure?: "binding_missing" | "choice_required" | "unknown_choice") { super("Invalid contextual decision"); }
}
