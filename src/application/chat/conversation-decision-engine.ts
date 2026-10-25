import { exchangeIdleMs } from "./exchange-window.js";
import { createHash, randomUUID } from "node:crypto";
import { addressedElsewhere, decisionSourceFailure, exchangeBranch, generatedContributionAllowed, groundedContextContinuation, isRecipientCorrection, localAddressing, optionalParticipationRejection, type CharacterDecision, type DecisionOutcome } from "./character-decision.js";
import { isGuardedContext } from "./guarded-conversation-context.js";
import { resolveConversationTrigger, type TriggerResolution } from "./conversation-trigger.js";
import { isOptionalInteraction } from "./chat-policy.js";
import type { ChatRequest, ChatResponse } from "./chat-provider.js";
import { emitChatDiagnostic, type DiagnosticLogger } from "../diagnostics/chat-diagnostics.js";
import { contributionPolicy, resolveParticipation, type ParticipationSettings } from "./participation-policy.js";

export type ConversationIntent = "answer" | "clarify" | "social" | "closing" | "contribute" | "abstain";
export interface ValidatedConversationDecision {
  decisionId: string; action: "reply" | "react" | "reply_and_react" | "silent"; intent: ConversationIntent;
  responseToEventId: string | null; referentSourceIds: readonly string[]; recipientIds: readonly string[];
  reasonCode: string; contextVersion: string; policyVersion: string; expiresAt: number;
  participationKind?: "continuation" | "spontaneous";
}
export interface ConversationDecisionResult {
  status: "ready" | "denied" | "failed";
  recovery: "none" | "error_reply";
  decision: ValidatedConversationDecision;
}
export interface ParticipationAssessment {
  result: ConversationDecisionResult; contribution: CharacterDecision["contribution"] | null;
  targetMessageId: string | null; targetConfidence: number; reaction: string | null; exchangeId: string | null;
  local: CharacterDecision["addressing"];
}
type Request = ChatRequest & { sourceMessageId?: string | null | undefined };
export function reportConversationDecision(logger: DiagnosticLogger | null, result: ConversationDecisionResult, stage: "preflight" | "generation", interaction: TriggerResolution["interaction"]): void {
  emitChatDiagnostic(logger, { event: "chat.decision.resolved", stage, interaction, status: result.status, recovery: result.recovery,
    decisionId: result.decision.decisionId, action: result.decision.action, intent: result.decision.intent, reason: result.decision.reasonCode,
    contextVersion: result.decision.contextVersion, policyVersion: result.decision.policyVersion });
}
function contextVersion(request: ChatRequest): string {
  return createHash("sha256").update(JSON.stringify([request.channelHistory, request.replyChain, request.currentBurst, request.currentEvent, request.message])).digest("hex").slice(0, 24);
}

// One owner of conversational admission and generated action validation.
// Access/source eligibility and scheduling/delivery freshness remain external
// mandatory gates; neither a model proposal nor fallback can override them.
export class ConversationDecisionEngine {
  private result(request: Request, trigger: TriggerResolution, now: number, policyVersion: string, reasonCode: string,
    status: ConversationDecisionResult["status"], action: ValidatedConversationDecision["action"], intent: ConversationIntent,
    references: readonly string[] = [], recovery: ConversationDecisionResult["recovery"] = "none"): ConversationDecisionResult {
    return { status, recovery, decision: { decisionId: randomUUID(), action, intent, responseToEventId: trigger.responseToEventId,
      referentSourceIds: references, recipientIds: [request.currentUser.id], reasonCode, contextVersion: contextVersion(request), policyVersion, expiresAt: now + 30_000 } };
  }

  public assess(request: Request, outcome: DecisionOutcome | { status: "skipped"; decision: null }, settings: ParticipationSettings | undefined,
    admissible: boolean, now: number, policyVersion: string): ParticipationAssessment {
    const trigger = resolveConversationTrigger(request); const botId = request.botUserId ?? "bot";
    const events = [...request.channelHistory, ...request.replyChain, ...(request.currentBurst ?? [])];
    const current = request.currentBurst?.at(-1) ?? (request.currentEvent?.type === "message" ? {
      messageId: request.currentEvent.messageId, timestampMs: request.currentEvent.timestampMs, authorId: request.currentUser.id,
      authorDisplayName: request.currentUser.displayName, content: request.message, imageCount: request.images.length,
      replyToMessageId: request.currentEvent.replyToMessageId } : undefined);
    let local = current ? localAddressing(events, current, botId, exchangeIdleMs, request.aliasCandidates) : "unclear";
    const elsewhere = !!current && addressedElsewhere(current, events, botId, request.aliasCandidates, !!outcome.decision?.contextual);
    const proposal = outcome.decision;
    const base = { contribution: null, targetMessageId: null, targetConfidence: 0, reaction: null, exchangeId: current ? exchangeBranch(events, current, botId) : null, local };
    const denied = (reason: string, status: ConversationDecisionResult["status"] = "denied"): ParticipationAssessment => ({ ...base,
      result: this.result(request, trigger, now, policyVersion, reason, status, "silent", "abstain") });
    if (!admissible) return denied("scope_or_disabled");
    if (trigger.explicit) return { ...base, result: this.result(request, trigger, now, policyVersion, "explicit_request", "ready", "reply", "answer") };
    if (proposal?.contextual?.action === "silent") return { ...base, result: this.result(request, trigger, now, policyVersion, "contextual_abstention", "ready", "silent", proposal.contextual.intent) };
    if (proposal?.contextual && request.currentEvent?.type === "reaction_snapshot" && isGuardedContext(request.contextLease)) {
      const snapshot = request.currentEvent; const interpretation = proposal.contextual; const link = interpretation.link;
      const actors = [...new Set(snapshot.reactions.flatMap((item) => item.actorIds))];
      if (!link || link.kind !== "reaction" || link.botEventId !== snapshot.targetMessageId || proposal.target !== snapshot.targetMessageId ||
          !actors.length || link.actorIds.length !== actors.length || link.actorIds.some((id) => !actors.includes(id)) ||
          !events.some((event) => event.messageId === snapshot.targetMessageId && event.authorId === botId) ||
          !proposal.recipientEvidence.includes(snapshot.targetMessageId) || proposal.recipientEvidence.some((id) => !events.some((event) => event.messageId === id))) return denied("invalid_evidence", "failed");
      if (interpretation.relationship !== "group" || interpretation.referent === "unresolved") return denied("recipient_unclear");
      const policy = resolveParticipation(settings, request.channelId);
      const reaction = interpretation.action === "react" && policy.reactionsEnabled !== false && request.optionalActionsAvailable?.reaction !== false &&
        proposal.recipientConfidence >= 0.7 && proposal.confidence >= 0.7 && proposal.opening === "clear" ? proposal.reaction : null;
      if (interpretation.action === "react" && !reaction) return denied("reaction_unavailable");
      const rejection = interpretation.action === "reply" ? optionalParticipationRejection("spontaneous", "others", proposal, false, contributionPolicy(settings)) : null;
      if (rejection) return denied(rejection);
      if (interpretation.action === "reply" && request.optionalActionsAvailable?.text === false) return denied("text_unavailable");
      const result = this.result(request, trigger, now, policyVersion, reaction ? "reaction_only" : "accepted_contribution", "ready", reaction ? "react" : "reply", interpretation.intent, proposal.recipientEvidence);
      result.decision.responseToEventId = snapshot.targetMessageId; result.decision.recipientIds = actors;
      return { ...base, result, targetMessageId: snapshot.targetMessageId, targetConfidence: proposal.targetConfidence, reaction, contribution: reaction ? null : proposal.contribution };
    }
    if (proposal?.contextual && isGuardedContext(request.contextLease)) {
      const failure = decisionSourceFailure(proposal, events.filter((event) => event.timestampMs <= now), botId,
        current?.messageId ?? null);
      if (failure) return denied(failure, "failed");
      const interpretation = proposal.contextual;
      if (current && isRecipientCorrection(current.content)) return denied("addressed_elsewhere");
      // This is a post-context semantic claim, not an ingress wording filter.
      // A linked referent still needs a real earlier authorized citation.
      if (!current || !proposal.recipientEvidence.includes(current.messageId) || interpretation.referent === "unresolved" ||
          interpretation.referent === "context_linked" && !events.some((event) => event.timestampMs < current.timestampMs &&
            proposal.recipientEvidence.includes(event.messageId))) return denied("referent_unresolved");
      const kind = interpretation.relationship === "followup" ? "continuation" : "spontaneous";
      const policy = resolveParticipation(settings, request.channelId);
      if (interpretation.relationship === "unclear") return denied("recipient_unclear");
      if (interpretation.relationship === "elsewhere" || elsewhere) return denied("addressed_elsewhere");
      if (!(kind === "continuation" ? policy.continuationEnabled : policy.spontaneousEnabled)) return denied(kind === "continuation" ? "continuation_disabled" : "spontaneous_disabled");
      if (kind === "continuation" && (!current || !proposal.recipientEvidence.includes(current.messageId) ||
          !groundedContextContinuation(events, current, botId, proposal,
            interpretation.intent === "social" || interpretation.intent === "closing"))) return denied("recipient_unclear");
      const availability = request.contextualActionAvailability?.[kind] ?? request.optionalActionsAvailable;
      const substantive = interpretation.intent === "answer" || interpretation.intent === "clarify";
      const reaction = interpretation.action === "react" && !substantive && availability?.reaction !== false &&
        proposal.confidence >= 0.7 && proposal.recipientConfidence >= 0.7 && proposal.opening === "clear" ? proposal.reaction : null;
      if (interpretation.action === "react" && !reaction) return denied(substantive ? "substantive_requires_text" : "reaction_unavailable");
      const rejection = interpretation.action === "reply" ? optionalParticipationRejection(kind,
        kind === "continuation" ? "continuing" : "others", proposal, false, contributionPolicy(settings), !(kind === "continuation" && substantive)) : null;
      if (rejection) return denied(rejection);
      if (interpretation.action === "reply" && availability?.text === false) return denied("text_unavailable");
      const result = this.result(request, trigger, now, policyVersion, reaction ? "reaction_only" : "accepted_contribution", "ready", reaction ? "react" : "reply", interpretation.intent, proposal.recipientEvidence);
      result.decision.participationKind = kind;
      result.decision.responseToEventId = proposal.target;
      result.decision.recipientIds = [events.find((event) => event.messageId === proposal.target)!.authorId];
      return { ...base, local: kind === "continuation" ? "continuing" : local, result, contribution: reaction ? null : proposal.contribution,
        targetMessageId: proposal.target, targetConfidence: proposal.targetConfidence, reaction };
    }
    if (proposal) {
      const failure = decisionSourceFailure(proposal, events.filter((event) => event.timestampMs <= now), botId, request.interaction === "implicit_followup" ? current?.messageId ?? null : null);
      if (failure) return denied(failure, "failed");
      // Only guarded evidence and a successful model decision can resolve an
      // older or cross-participant exchange. Failure fallback stays recent-only.
      if (current && !elsewhere && isGuardedContext(request.contextLease) &&
          groundedContextContinuation(events.filter((event) => event.timestampMs <= now), current, botId, proposal)) {
        local = "continuing"; base.local = local;
      }
    }
    if (!proposal) {
      // A missing or failed interpretation is silence, never a different path.
      return denied(outcome.status === "unavailable" ? "decision_unavailable" : "decision_failed", "failed");
    }
    const optional = isOptionalInteraction(request.interaction);
    const rejection = optional ? optionalParticipationRejection(request.interaction === "implicit_followup" ? "continuation" : "spontaneous", local, proposal, elsewhere, contributionPolicy(settings))
      : proposal.opening !== "clear" ? "opening_not_clear" : null;
    const textAllowed = !rejection && request.optionalActionsAvailable?.text !== false;
    const reaction = !textAllowed && request.interaction !== "implicit_followup" && request.optionalActionsAvailable?.reaction !== false && proposal.reaction &&
      proposal.confidence >= 0.7 && proposal.targetConfidence >= 0.7 && proposal.opening !== "unclear" ? proposal.reaction : null;
    const result = this.result(request, trigger, now, policyVersion, textAllowed ? "accepted_contribution" : reaction ? "reaction_only" : rejection ?? "text_unavailable",
      "ready", textAllowed ? "reply" : reaction ? "react" : "silent", textAllowed ? "contribute" : "abstain", proposal.recipientEvidence);
    const target = events.find((event) => event.messageId === proposal.target);
    if (target) { result.decision.responseToEventId = target.messageId;
      result.decision.recipientIds = proposal.contribution.recipientId === "group" ? [] : [target.authorId]; }
    return { ...base, result, targetMessageId: proposal.target, targetConfidence: proposal.targetConfidence,
      contribution: textAllowed ? proposal.contribution : null, reaction };
  }

  public finalize(request: Request, response: ChatResponse, now: number, policyVersion = "generation", prior?: ConversationDecisionResult): ConversationDecisionResult {
    const trigger = resolveConversationTrigger(request);
    if (request.functionalToolExecuted || response.outputOrigin === "tool") return this.result(request, trigger, now, policyVersion, "functional_confirmation", "ready", "reply", "answer");
    const references = response.referentSourceIds ?? prior?.decision.referentSourceIds ?? [];
    const ids = new Set([...request.channelHistory, ...request.replyChain, ...(request.currentBurst ?? [])].map((event) => event.messageId));
    if (trigger.responseToEventId) ids.add(trigger.responseToEventId);
    if (references.some((id) => !ids.has(id))) return this.result(request, trigger, now, policyVersion, "invalid_evidence", "failed", "silent", "abstain", [], trigger.explicit ? "error_reply" : "none");
    if (prior && prior.decision.action === "silent") return prior;
    let reply = prior?.decision.action !== "react" && (trigger.explicit || response.ambientAction === "reply");
    const intent = response.responseIntent ?? prior?.decision.intent ?? (trigger.explicit ? "answer" : "contribute");
    if (trigger.explicit && response.ambientAction === "ignore" && request.allowSilentDirect && (intent === "social" || intent === "closing")) reply = false;
    if (reply && !response.text.trim() && !response.generatedImages.length) return this.result(request, trigger, now, policyVersion, "empty_generated_reply", "failed", "silent", "abstain", [], trigger.explicit ? "error_reply" : "none");
    const groundedAnswer = prior?.decision.participationKind === "continuation" && (prior.decision.intent === "answer" || prior.decision.intent === "clarify");
    if (reply && groundedAnswer && intent !== "answer" && intent !== "clarify") return this.result(request, trigger, now, policyVersion, "substantive_requires_answer", "failed", "silent", "abstain");
    const rejectedContribution = prior?.decision.action === "reply" && !trigger.explicit && !groundedAnswer &&
      !generatedContributionAllowed(response.text, [...request.channelHistory, ...request.replyChain], request.botUserId);
    if (rejectedContribution) reply = false;
    const react = response.reactionEmoji !== null || response.historyReactions.length > 0;
    const result = this.result(request, trigger, now, policyVersion, reply ? trigger.explicit ? "explicit_request" : "accepted_contribution" : rejectedContribution ? "generated_contribution_rejected" : "contextual_abstention",
      "ready", reply ? react ? "reply_and_react" : "reply" : react ? "react" : "silent", reply || intent === "social" || intent === "closing" ? intent : "abstain", references);
    if (prior) { result.status = prior.status; result.recovery = prior.recovery; result.decision.decisionId = prior.decision.decisionId;
      result.decision.responseToEventId = prior.decision.responseToEventId;
      if (!trigger.explicit) result.decision.recipientIds = prior.decision.recipientIds;
      if (prior.decision.participationKind) result.decision.participationKind = prior.decision.participationKind;
      if (!trigger.explicit) result.decision.expiresAt = prior.decision.expiresAt;
      if (reply || prior.decision.action !== "reply") result.decision.reasonCode = prior.decision.reasonCode; }
    return result;
  }
}
