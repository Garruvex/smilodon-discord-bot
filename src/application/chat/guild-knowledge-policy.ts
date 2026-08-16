import type { ProposedGuildKnowledgeCandidate } from "./chat-provider.js";

const subjectTypes = new Set(["guild", "member", "team", "project"]);
const topics = new Set([
  "nickname",
  "community",
  "community_activity",
  "project_contribution",
  "public_interest",
  "event_responsibility",
  "team_membership",
  "responsibility",
  "terminology",
  "project",
  "schedule",
]);
const slotPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const unsafePatterns = [
  /\b(?:password|passwd|token|api[_ -]?key)\s*[:=]\s*\S+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:medical|diagnosis|salary|debt|address|phone number)\b/i,
  /\b(?:owner|administrator|moderator)\b/i,
];

export const guildKnowledgeLimits = {
  maxConfirmedRecords: 100,
  maxCandidateRecords: 250,
  maxStatementChars: 200,
  maxSerializedChars: 16_000,
  maxCandidatesPerResponse: 3,
  candidateTtlMs: 30 * 24 * 60 * 60 * 1_000,
} as const;

export const selfConfirmingGuildTopics = new Set([
  "nickname",
  "community_activity",
  "project_contribution",
  "public_interest",
  "event_responsibility",
  "team_membership",
]);

export function validateGuildKnowledgeCandidates(
  candidates: readonly ProposedGuildKnowledgeCandidate[],
  input: {
    guildId: string;
    currentUserId: string;
    allowedMemberIds: ReadonlySet<string>;
  },
): ProposedGuildKnowledgeCandidate[] {
  const valid: ProposedGuildKnowledgeCandidate[] = [];
  for (const candidate of candidates.slice(0, guildKnowledgeLimits.maxCandidatesPerResponse)) {
    const topic = candidate.topic.trim().toLowerCase();
    const slot = candidate.slot.trim().toLowerCase();
    const statement = candidate.statement.replace(/\s+/g, " ").trim();
    if (!subjectTypes.has(candidate.subjectType) || !topics.has(topic)) continue;
    if (!slot || slot.length > 60 || !slotPattern.test(slot)) continue;
    if (!statement || statement.length > guildKnowledgeLimits.maxStatementChars) continue;
    if (unsafePatterns.some((pattern) => pattern.test(statement))) continue;
    if (candidate.subjectType === "member" && !input.allowedMemberIds.has(candidate.subjectId)) continue;
    if (candidate.subjectType === "guild" && candidate.subjectId !== input.guildId) continue;
    if ((candidate.subjectType === "team" || candidate.subjectType === "project") && candidate.subjectId.length > 80) continue;
    valid.push({ ...candidate, topic, slot, statement });
  }
  return valid;
}

export function maySelfConfirm(
  candidate: ProposedGuildKnowledgeCandidate,
  assertedByUserId: string,
): boolean {
  return candidate.subjectType === "member" &&
    candidate.subjectId === assertedByUserId &&
    selfConfirmingGuildTopics.has(candidate.topic);
}

export const guildKnowledgeInstructions = `Shared guild knowledge rules:
- Propose only lightweight, durable, publicly appropriate community knowledge.
- Good candidates include public nicknames, recurring community activities, project contributions, public interests, event responsibilities, team membership, terminology, and stable project facts.
- Never propose private, sensitive, medical, financial, contact, moderation, authority, credential, conflict, or activity-log information.
- Do not turn ordinary one-off actions into guild knowledge.
- A claim about another member remains a candidate and must not be presented as confirmed truth.
- Use only supplied member IDs. For guild subjects, use the supplied guild ID.
- When uncertain, propose no guild candidates.`;
