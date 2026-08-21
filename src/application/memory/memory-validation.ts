import type { ProposedMemory } from "./memory.js";

// Same slot-format and secret-detection rules as the legacy
// chat-memory-policy.ts/guild-knowledge-policy.ts (both stay in place for
// the not-yet-migrated legacy tables) — reused here rather than re-derived,
// adapted for the unified proposal shape.
const slotPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const secretPatterns = [
  /\b(?:sk|ghp|github_pat)_[a-z0-9_-]{16,}\b/i,
  /\b(?:password|passwd|token|api[_ -]?key)\s*[:=]\s*\S+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:\d[ -]*?){13,19}\b/,
  /\b(?:medical|diagnosis|salary|debt|address|phone number)\b/i,
];

export const memoryValidationLimits = {
  maxStatementChars: 200,
  maxSlotChars: 60,
  maxTopicChars: 60,
} as const;

export interface ValidatedProposal {
  proposal: ProposedMemory;
  topic: string;
  slot: string;
  statement: string | null;
}

// Normalizes and rejects malformed/unsafe proposals — mirrors
// validateMemoryActions/validateGuildKnowledgeCandidates' checks, but
// topic/kind vocabulary is intentionally unenumerated here (kind already
// carries content shape; callers upstream — chat-memory-policy's
// memoryTopicIds, guild-knowledge-policy's topics set — still constrain
// what the model is prompted to produce before it reaches this layer).
export function validateProposal(proposal: ProposedMemory): ValidatedProposal | null {
  const topic = proposal.topic.trim().toLowerCase();
  const slot = proposal.slot.trim().toLowerCase();
  if (!topic || topic.length > memoryValidationLimits.maxTopicChars) return null;
  if (!slot || slot.length > memoryValidationLimits.maxSlotChars || !slotPattern.test(slot)) return null;
  if (proposal.action === "remove") {
    return { proposal, topic, slot, statement: null };
  }
  const statement = proposal.statement.replace(/\s+/g, " ").trim();
  if (!statement || statement.length > memoryValidationLimits.maxStatementChars) return null;
  if (secretPatterns.some((pattern) => pattern.test(statement))) return null;
  return { proposal, topic, slot, statement };
}
