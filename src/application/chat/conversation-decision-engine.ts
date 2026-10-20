import { createHash, randomUUID } from "node:crypto";
import { addressedElsewhere, decisionSourceFailure, exchangeBranch, generatedContributionAllowed, groundedContextContinuation, localAddressing, optionalParticipationRejection, type CharacterDecision, type DecisionOutcome } from "./character-decision.js";
import { isGuardedContext } from "./guarded-conversation-context.js";
import { resolveConversationTrigger, type TriggerResolution } from "./conversation-trigger.js";
import type { ChatRequest, ChatResponse } from "./chat-provider.js";
import { emitChatDiagnostic, type DiagnosticLogger } from "../diagnostics/chat-diagnostics.js";
import { contributionPolicy, type ParticipationSettings } from "./participation-policy.js";

export type ConversationIntent = "answer" | "clarify" | "social" | "closing" | "contribute" | "abstain";
export interface ValidatedConversationDecision {
  decisionId: string; action: "reply" | "react" | "reply_and_react" | "silent"; intent: ConversationIntent;
  responseToEventId: string | null; referentSourceIds: readonly string[]; recipientIds: readonly string[];
  reasonCode: string; contextVersion: string; policyVersion: string; expiresAt: number;
}
export interface ConversationDecisionResult {
  status: "ready" | "denied" | "failed";
  recovery: "none" | "grounded_reply" | "error_reply";
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
  public canUseGroundedContinuation(request: ChatRequest, now: number): boolean {
    const events = [...request.channelHistory, ...request.replyChain, ...(request.currentBurst ?? [])];
    const current = request.currentBurst?.at(-1);
    if (!current || current.authorId !== request.currentUser.id || now < current.timestampMs || now - current.timestampMs >= 30_000 || localAddressing(events, current, request.botUserId ?? "bot", true, 120_000, request.aliasCandidates) !== "continuing") return false;
    return events.some((event) => event.authorId === request.botUserId && event.replyToAuthorId === current.authorId &&
      event.timestampMs < current.timestampMs && now - event.timestampMs <= 120_000 && event.replyToMessageId &&
      events.some((human) => human.messageId === event.replyToMessageId && human.authorId === current.authorId && human.timestampMs < event.timestampMs));
  }
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
    let local = current ? localAddressing(events, current, botId, true, 120_000, request.aliasCandidates) : "unclear";
    const elsewhere = !!current && addressedElsewhere(current, events, botId, request.aliasCandidates);
    const proposal = outcome.decision;
    const base = { contribution: null, targetMessageId: null, targetConfidence: 0, reaction: null, exchangeId: current ? exchangeBranch(events, current, botId) : null, local };
    const denied = (reason: string, status: ConversationDecisionResult["status"] = "denied"): ParticipationAssessment => ({ ...base,
      result: this.result(request, trigger, now, policyVersion, reason, status, "silent", "abstain") });
    if (!admissible) return denied("scope_or_disabled");
    if (trigger.explicit) return { ...base, result: this.result(request, trigger, now, policyVersion, "explicit_request", "ready", "reply", "answer") };
    if (proposal) {
      const failure = decisionSourceFailure(proposal, events.filter((event) => event.timestampMs <= now), botId, request.triggerMode === "continuation" ? current?.messageId ?? null : null);
      if (failure) return denied(failure, "failed");
      // Only guarded evidence and a successful model decision can resolve an
      // older or cross-participant exchange. Failure fallback stays recent-only.
      if (current && !elsewhere && isGuardedContext(request.contextLease) &&
          groundedContextContinuation(events.filter((event) => event.timestampMs <= now), current, botId, proposal)) {
        local = "continuing"; base.local = local;
      }
    }
    if (!proposal) {
      // Fallback is opt-in and skips ONLY a broken decision call. The
      // confirmed same-person branch must still exist when delivery occurs.
      const fallback = outcome.status !== "skipped" && request.triggerMode === "continuation" &&
        settings?.continuationFailureMode === "grounded_fallback" && this.canUseGroundedContinuation({ ...request, currentBurst: current ? [current] : [] }, now) && local === "continuing" && !elsewhere && request.optionalActionsAvailable?.text !== false;
      if (fallback) return { ...base, targetMessageId: current!.messageId, targetConfidence: 1,
        result: this.result(request, trigger, now, policyVersion, "decision_failure_grounded_continuation", "failed", "reply", "answer", [current!.messageId], "grounded_reply") };
      return denied(outcome.status === "unavailable" ? "decision_unavailable" : "decision_failed", "failed");
    }
    const optional = request.triggerMode === "continuation" || request.triggerMode === "spontaneous";
    const rejection = optional ? optionalParticipationRejection(request.triggerMode as "continuation" | "spontaneous", local, proposal, elsewhere, contributionPolicy(settings))
      : proposal.opening !== "clear" ? "opening_not_clear" : null;
    const textAllowed = !rejection && request.optionalActionsAvailable?.text !== false;
    const reaction = !textAllowed && request.triggerMode !== "continuation" && request.optionalActionsAvailable?.reaction !== false && proposal.reaction &&
      proposal.confidence >= 0.7 && proposal.targetConfidence >= 0.7 && proposal.opening !== "unclear" ? proposal.reaction : null;
    const result = this.result(request, trigger, now, policyVersion, textAllowed ? "accepted_contribution" : reaction ? "reaction_only" : rejection ?? "text_unavailable",
      "ready", textAllowed ? "reply" : reaction ? "react" : "silent", textAllowed ? "contribute" : "abstain", proposal.recipientEvidence);
    const target = events.find((event) => event.messageId === proposal.target);
    if (target) result.decision.recipientIds = proposal.contribution.recipientId === "group" ? [] : [target.authorId];
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
    let reply = trigger.explicit || response.ambientAction === "reply";
    const intent = response.responseIntent ?? (trigger.explicit || prior?.recovery === "grounded_reply" ? "answer" : "contribute");
    if (trigger.explicit && response.ambientAction === "ignore" && request.allowSilentDirect && (intent === "social" || intent === "closing")) reply = false;
    if (prior?.recovery === "grounded_reply") reply = true;
    if (prior?.recovery === "grounded_reply" && intent !== "answer" && intent !== "clarify") return this.result(request, trigger, now, policyVersion, "fallback_requires_answer_or_clarification", "failed", "silent", "abstain");
    if (reply && !response.text.trim() && !response.generatedImages.length) return this.result(request, trigger, now, policyVersion, "empty_generated_reply", "failed", "silent", "abstain", [], trigger.explicit ? "error_reply" : "none");
    const rejectedContribution = prior?.decision.action === "reply" && !trigger.explicit && prior.recovery !== "grounded_reply" &&
      !generatedContributionAllowed(response.text, [...request.channelHistory, ...request.replyChain], request.botUserId);
    if (rejectedContribution) reply = false;
    const react = response.reactionEmoji !== null || response.historyReactions.length > 0;
    const result = this.result(request, trigger, now, policyVersion, reply ? trigger.explicit ? "explicit_request" : "accepted_contribution" : rejectedContribution ? "generated_contribution_rejected" : "contextual_abstention",
      "ready", reply ? react ? "reply_and_react" : "reply" : react ? "react" : "silent", reply || intent === "social" || intent === "closing" ? intent : "abstain", references);
    if (prior) { result.status = prior.status; result.recovery = prior.recovery; result.decision.decisionId = prior.decision.decisionId;
      if (!trigger.explicit) result.decision.recipientIds = prior.decision.recipientIds;
      if (!trigger.explicit) result.decision.expiresAt = prior.decision.expiresAt;
      if (reply || prior.decision.action !== "reply") result.decision.reasonCode = prior.decision.reasonCode; }
    return result;
  }
}
