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
  // Server-assigned only (never proposed by the main chat model) — used
  // exclusively by episodic consolidation to summarize exchanges about to
  // age out of a channel's recent-history window. See
  // ChatConversationService's post-commit consolidation step.
  "scene_summary",
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
  // Channel summaries extract from a whole batch of messages, not one
  // conversational turn — see channel-message-summarization.ts's schema,
  // which already caps the model's own output at 5. Passed explicitly as
  // validateGuildKnowledgeCandidates' maxCandidates override so a valid
  // 4th/5th fact isn't silently sliced off by the live-chat-sized default.
  maxChannelSummaryCandidates: 5,
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

export interface ValidatedGuildKnowledgeCandidate extends ProposedGuildKnowledgeCandidate {
  // Resolved from the raw model-authored `channelScoped` flag against the
  // turn's actual channel — null means guild-wide, matching the stored
  // column's semantics (see guild_knowledge.channelId in schema.ts).
  channelId: string | null;
}

export function validateGuildKnowledgeCandidates(
  candidates: readonly ProposedGuildKnowledgeCandidate[],
  input: {
    guildId: string;
    currentChannelId: string;
    currentUserId: string;
    allowedMemberIds: ReadonlySet<string>;
    maxCandidates?: number;
  },
): ValidatedGuildKnowledgeCandidate[] {
  const valid: ValidatedGuildKnowledgeCandidate[] = [];
  for (const candidate of candidates.slice(0, input.maxCandidates ?? guildKnowledgeLimits.maxCandidatesPerResponse)) {
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
    valid.push({
      ...candidate, topic, slot, statement,
      channelId: candidate.channelScoped ? input.currentChannelId : null,
    });
  }
  return valid;
}

export function maySelfConfirm(
  candidate: ProposedGuildKnowledgeCandidate,
  // Null for a consolidation-authored candidate (no single asserting user)
  // — always falls through to false, since there's no subject to match.
  assertedByUserId: string | null,
): boolean {
  return assertedByUserId !== null &&
    candidate.subjectType === "member" &&
    candidate.subjectId === assertedByUserId &&
    selfConfirmingGuildTopics.has(candidate.topic);
}

export const guildKnowledgeInstructions = `Shared guild knowledge rules:
- Propose only lightweight, durable, publicly appropriate community knowledge.
- Good candidates include public nicknames, recurring community activities, project contributions, public interests, event responsibilities, team membership, terminology, and stable project facts.
- Never propose private, sensitive, medical, financial, contact, moderation, authority, credential, conflict, or activity-log information.
- Do not turn ordinary one-off actions into guild knowledge.
- A claim about another member remains a candidate and must not be presented as confirmed truth.
- A statement one member makes about another member's preferences, habits, or traits belongs here as a member-subject candidate, not as the asserting user's private memory.
- Use only a supplied member ID: the current user, an explicitly @mentioned user, or a reply-chain author shown in <reply_chain>. For guild subjects, use the supplied guild ID.
- Set channelScoped=true when the fact describes something specific to what's happening in this channel/scene right now (a location, an in-progress event, a temporary state) rather than a durable fact true anywhere in the guild. Most nickname/community/team-membership candidates should stay channelScoped=false (guild-wide).
- When uncertain, propose no guild candidates.`;
