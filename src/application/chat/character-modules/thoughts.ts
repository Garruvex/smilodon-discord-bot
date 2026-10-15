import type { CharacterDecisionInput, CharacterModule, CharacterTurn } from "../character-module-registry.js";
import type { ChatRequest } from "../chat-provider.js";
import { eligibleContribution, exchangeBranch, type ContributionCandidate } from "../character-decision.js";

interface HeldThought { candidate: ContributionCandidate; scope: string; expiresAt: number }
export class ThoughtsModule implements CharacterModule {
  public readonly id = "thoughts";
  private readonly reservoir = new Map<string, HeldThought[]>();
  public reset(guildId?: string, channelId?: string): void {
    for (const key of this.reservoir.keys()) if (!guildId || (channelId ? key === `${guildId}:${channelId}` : key.startsWith(`${guildId}:`))) this.reservoir.delete(key);
  }
  public onDecision(turn: CharacterTurn, input: CharacterDecisionInput): { request: ChatRequest; allowed: boolean } {
    const request = turn.request; const controls = turn.settings.modules.thoughts; const decision = input.decision;
    const key = `${request.guildId}:${request.channelId}`;
    if (!decision || !input.optional || decision.opening !== "clear") { this.reservoir.delete(key); return { request, allowed: true }; }
    const current = input.burst.at(-1); if (!current) return { request, allowed: true };
    const scope = JSON.stringify([exchangeBranch(input.events, current, request.botUserId ?? "bot"), decision.contribution.recipientId, decision.boundary, turn.settings, input.policy]);
    const candidates = decision.thoughts.filter((candidate) => eligibleContribution(candidate, request.triggerMode === "spontaneous" ? "spontaneous" : "continuation", input.policy) && candidate.recipientId === decision.contribution.recipientId);
    // Held candidates must be explicitly reassessed in the new valid decision.
    const held = (this.reservoir.get(key) ?? []).filter((thought) => thought.scope === scope && thought.expiresAt > turn.now &&
      candidates.some((candidate) => candidate.sourceMessageId === thought.candidate.sourceMessageId && candidate.text === thought.candidate.text));
    for (const candidate of candidates) if (!held.some((thought) => thought.candidate.text === candidate.text && thought.candidate.sourceMessageId === candidate.sourceMessageId))
      held.push({ candidate, scope, expiresAt: turn.now + controls.holdSeconds * 1000 });
    if (this.reservoir.size >= 256 && !this.reservoir.has(key)) this.reservoir.delete(this.reservoir.keys().next().value!);
    this.reservoir.set(key, held.slice(-3));
    // The baseline accepted contribution always controls admission; shadow
    // thoughts neither authorize output nor veto another eligible contribution.
    const selected = !controls.shadow && held.find((thought) => thought.candidate.sourceMessageId === decision.contribution.sourceMessageId && thought.candidate.text === decision.contribution.text);
    return { request: selected ? { ...request, characterContext: [...(request.characterContext ?? []), { moduleId: "thoughts", text: `Reassessed candidate, subordinate to the accepted contribution: ${JSON.stringify(selected.candidate)}` }] } : request, allowed: true };
  }
}
