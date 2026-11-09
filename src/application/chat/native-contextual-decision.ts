import { z } from "zod";
import type { CharacterDecision } from "./character-decision.js";
import { contributionLabels } from "./contribution-labels.js";
import { ContextualContractError, type contextualDecisionContract } from "./contextual-decision-contract.js";

const probability = z.number().finite().min(0).max(1);
export const nativeContextualAdapterRevision = 2;
const valuesSchema = z.object({
  relationship: z.enum(["followup", "group", "elsewhere", "unclear"]),
  intent: z.enum(["answer", "clarify", "social", "closing", "contribute", "abstain"]),
  action: z.enum(["reply", "react", "silent"]), referent: z.enum(["self_contained", "context_linked", "unresolved"]),
  opening: z.enum(["clear", "closed", "unclear"]), linkKey: z.string(), targetKey: z.string(),
  contributionLabel: z.enum(contributionLabels), motivation: probability, addsValue: z.boolean(),
  reaction: z.enum(["none", "👍", "❤️", "😂", "😮", "😢"]),
});

// No generated candidate prose, authored destination IDs, or model-written
// confidence scores. Native choice probabilities bind only supplied candidates.
export function nativeContextualDecisionContract(contract: ReturnType<typeof contextualDecisionContract>, fixedTarget: string | null): {
  schema: Record<string, unknown>; parse: (raw: unknown) => CharacterDecision;
} {
  const choice = (options: readonly string[], description: string, descriptions?: Record<string, string>): Record<string, unknown> =>
    ({ type: "string", enum: options, description, ...(descriptions ? { "x-choice-descriptions": descriptions } : {}) });
  const fixedCandidate = contract.targets.find((target) => target.eventId === fixedTarget);
  const evidenceKey = (eventId: string): string => contract.evidenceSources.find((source) => source.eventId === eventId)?.key ?? eventId;
  const properties: Record<string, unknown> = {
    relationship: choice(valuesSchema.shape.relationship.options, "Who does the current message address: a grounded bot followup, the whole group, another human, or unclear? A correction or repair request directed at the bot is a followup."),
    intent: choice(valuesSchema.shape.intent.options, "What is the current speaker's intent? Corrections and repair-status questions require an answer or clarification. Thanks alone is social; explicitly excluding the bot is closing."),
    action: choice(valuesSchema.shape.action.options, "Choose reply for a grounded substantive request or a useful group contribution; react or silent for thanks/closing; silent for elsewhere, unclear, or unresolved references. Respect available actions."),
    referent: choice(valuesSchema.shape.referent.options, "Is the current message self-contained, resolved by earlier supplied events, or missing essential context? An isolated 'is it ready?' without a task is unresolved."),
    opening: choice(valuesSchema.shape.opening.options, "Is there a clear opening for the bot to respond without interrupting?"),
    linkKey: choice(["none", ...contract.links.map((link) => link.key)], "Select the supplied exchange establishing the classified followup or reaction scope. Same subject alone is insufficient; explicit bot correction can reference another speaker's exchange.",
      Object.fromEntries(contract.links.map(({ key, link }) => [key, link.kind === "reaction" ? `Reaction to bot event ${evidenceKey(link.botEventId)}` :
        `${link.kind}: human event ${evidenceKey(link.humanEventId)} and bot answer ${evidenceKey(link.botEventId)}`]))),
    targetKey: choice(fixedTarget ? [fixedCandidate?.key ?? "none"] : ["none", ...contract.targets.map((target) => target.key)],
      "Select the eligible supplied response target. A fixed destination is bound by the application and does not prove the bot is addressed.",
      Object.fromEntries(contract.targets.map((target) => [target.key, `Respond to event ${evidenceKey(target.eventId)}`]))),
    contributionLabel: choice(contributionLabels, "Classify the proposed kind of response, without drafting it. Grounded answers use answer. Select none if no useful response is supported. Generic advice, speculation, acknowledgment-only and repetition are not substantive contributions."),
    motivation: { type: "number", minimum: 0, maximum: 1, description: "Would a substantive contribution from the bot be relevant, welcome and worthwhile in this exact conversation?" },
    addsValue: { type: "boolean", description: "Can the bot provide a specific grounded answer or useful contribution, beyond merely repeating, acknowledging, offering generic advice, or inventing facts?" },
    reaction: choice(valuesSchema.shape.reaction.options, "Choose one appropriate acknowledgment emoji only for action react; otherwise none."),
  };
  for (const source of contract.evidenceSources) properties[`evidence_${source.key}`] = {
    type: "boolean", description: `Does supplied event ${source.key} directly support the selected recipient/referent/action? Include the current event for any human response. Shared topic alone is not recipient evidence.`,
  };
  const schema = { type: "object", "x-native-contextual": true, additionalProperties: false, required: Object.keys(properties), properties };
  return { schema, parse: (raw): CharacterDecision => {
    const response = z.object({ values: z.record(z.unknown()), confidence: z.record(probability) }).strict().parse(raw);
    const expected = Object.keys(properties).sort();
    if (JSON.stringify(Object.keys(response.values).sort()) !== JSON.stringify(expected)
      || JSON.stringify(Object.keys(response.confidence).sort()) !== JSON.stringify(expected)) throw new ContextualContractError("invalid_evidence");
    const values = valuesSchema.parse(response.values);
    const selected = contract.targets.find((target) => target.key === values.targetKey);
    if (values.targetKey !== "none" && !selected || fixedTarget && values.action !== "silent" && selected?.eventId !== fixedTarget) throw new ContextualContractError("invalid_target");
    const evidence = contract.evidenceSources.filter((source) => z.boolean().parse(response.values[`evidence_${source.key}`]))
      .sort((left, right) => response.confidence[`evidence_${right.key}`]! - response.confidence[`evidence_${left.key}`]!).slice(0, 5).map((source) => source.key);
    const evidenceConfidence = Math.min(1, ...evidence.map((key) => response.confidence[`evidence_${key}`]!));
    // Linked events are bound by the contract, not by independent evidence votes.
    // Keep optional evidence-selection uncertainty out of recipient/target scores.
    const recipientEvidenceConfidence = values.linkKey !== "none" ? 1 : evidenceConfidence;
    const confidence = Math.min(recipientEvidenceConfidence, ...["relationship", "action", "referent", "targetKey", ...(values.linkKey !== "none" ? ["linkKey"] : []),
      ...(values.action === "reply" && values.intent === "contribute" ? ["contributionLabel", "addsValue"] : [])].map((key) => response.confidence[key]!));
    const recipientConfidence = Math.min(recipientEvidenceConfidence, response.confidence.relationship!, values.linkKey !== "none" ? response.confidence.linkKey! : 1);
    const result = contract.parse({ relationship: values.relationship, intent: values.intent, action: values.action,
      referent: values.referent, opening: values.opening, linkKey: values.linkKey === "none" ? null : values.linkKey,
      recipientEvidence: evidence, recipientConfidence, confidence,
      contribution: values.action === "reply" ? { text: "", adds: "", label: values.contributionLabel, motivation: values.motivation } : null,
      reaction: values.reaction === "none" ? null : values.reaction,
      ...(!fixedTarget ? { targetKey: values.targetKey === "none" ? null : values.targetKey } : {}) });
    if (values.action === "reply") result.nativeContributionPlan = { addsValue: values.addsValue };
    result.targetConfidence = response.confidence.targetKey!;
    result.nativeConfidence = { relationship: response.confidence.relationship!, link: response.confidence.linkKey!,
      evidenceSelection: evidenceConfidence, target: response.confidence.targetKey!, action: response.confidence.action!, referent: response.confidence.referent! };
    return result;
  } };
}
