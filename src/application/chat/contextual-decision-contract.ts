import { z } from "zod";
import { contributionLabels, type CharacterDecision } from "./character-decision.js";
import type { ChannelHistoryMessage } from "./chat-provider.js";

export interface ContextualInterpretation {
  version: "contextual_v1";
  relationship: "followup" | "group" | "elsewhere" | "unclear";
  intent: "answer" | "clarify" | "social" | "closing" | "contribute" | "abstain";
  action: "reply" | "react" | "silent";
}

// The wire contract has no Discord destination/author fields. Fixed bindings
// have no target choice; group choices use opaque per-call keys.
export function contextualDecisionContract(events: readonly ChannelHistoryMessage[], botId: string, fixedTarget: string | null): {
  schema: Record<string, unknown>; targets: readonly { key: string; eventId: string }[]; parse: (raw: unknown) => CharacterDecision;
} {
  const humans = events.filter((event) => event.authorId !== botId && event.author?.kind !== "bot");
  const candidates = fixedTarget ? humans.filter((event) => event.messageId === fixedTarget) : humans.filter((event) =>
    !events.some((reply) => reply.authorId === botId && reply.replyToMessageId === event.messageId));
  const targets = candidates.map((event, index) => ({ key: `candidate_${index + 1}`, eventId: event.messageId }));
  const probability = z.number().min(0).max(1);
  const shortText = z.string().superRefine((text, context) => {
    if ([...text].length > 200) context.addIssue({ code: "too_big", type: "string", maximum: 200, inclusive: true });
  });
  const contribution = z.object({ text: shortText, adds: shortText, label: z.enum(contributionLabels), motivation: probability }).strict();
  const validator = z.object({
    relationship: z.enum(["followup", "group", "elsewhere", "unclear"]),
    intent: z.enum(["answer", "clarify", "social", "closing", "contribute", "abstain"]), action: z.enum(["reply", "react", "silent"]),
    recipientEvidence: z.array(z.string()).max(8), recipientConfidence: probability, confidence: probability,
    opening: z.enum(["clear", "closed", "unclear"]), contribution: contribution.nullable(), reaction: z.string().nullable(),
    ...(!fixedTarget ? { targetKey: z.string().nullable() } : {}),
  }).strict();
  const probabilityJson = { type: "number", minimum: 0, maximum: 1 };
  const properties = {
    relationship: { type: "string", enum: ["followup", "group", "elsewhere", "unclear"] },
    intent: { type: "string", enum: ["answer", "clarify", "social", "closing", "contribute", "abstain"] },
    action: { type: "string", enum: ["reply", "react", "silent"] },
    recipientEvidence: { type: "array", items: { type: "string", enum: [...new Set(events.map((event) => event.messageId))] }, maxItems: 8 },
    recipientConfidence: probabilityJson, confidence: probabilityJson,
    opening: { type: "string", enum: ["clear", "closed", "unclear"] }, reaction: { type: ["string", "null"] },
    contribution: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false,
      required: ["text", "adds", "label", "motivation"], properties: {
        text: { type: "string", maxLength: 200 }, adds: { type: "string", maxLength: 200 },
        label: { type: "string", enum: contributionLabels }, motivation: probabilityJson,
      } }] },
    ...(!fixedTarget ? { targetKey: { type: ["string", "null"], enum: [null, ...targets.map((target) => target.key)] } } : {}),
  };
  return { schema: { type: "object", additionalProperties: false, required: Object.keys(properties), properties }, targets,
    parse: (raw): CharacterDecision => {
      const result = validator.parse(raw);
      if (result.recipientEvidence.some((id) => !events.some((event) => event.messageId === id))) throw new ContextualContractError("invalid_evidence");
      const targetId = fixedTarget ?? targets.find((target) => target.key === result.targetKey)?.eventId;
      const target = candidates.find((event) => event.messageId === targetId);
      if (result.action !== "silent" && !target) throw new ContextualContractError("invalid_target");
      if (result.action === "reply" && !result.contribution) throw new ContextualContractError("invalid_contribution");
      if (result.action !== "silent" && !result.recipientEvidence.length) throw new ContextualContractError("invalid_evidence");
      if (!fixedTarget && result.targetKey !== null && !targets.some((item) => item.key === result.targetKey)) throw new ContextualContractError("invalid_target");
      return { addressing: result.relationship === "followup" ? "continuing" : result.relationship === "group" || result.relationship === "elsewhere" ? "others" : "unclear",
        motivation: result.contribution?.motivation ?? 0, recipientEvidence: result.recipientEvidence, recipientConfidence: result.recipientConfidence,
        targetConfidence: result.confidence, confidence: result.confidence, opening: result.opening, boundary: "earlier", target: target?.messageId ?? "",
        contribution: { text: result.contribution?.text ?? "", adds: result.contribution?.adds ?? "", label: result.contribution?.label ?? "none",
          motivation: result.contribution?.motivation ?? 0, sourceMessageId: target?.messageId ?? "", recipientId: target?.authorId ?? "group" },
        reaction: result.reaction, thoughts: [], contextual: { version: "contextual_v1", relationship: result.relationship, intent: result.intent, action: result.action } };
    } };
}
export class ContextualContractError extends Error {
  public constructor(public readonly failure: "invalid_target" | "invalid_evidence" | "invalid_contribution") { super("Invalid contextual decision"); }
}
