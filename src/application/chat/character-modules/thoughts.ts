import type { CharacterDecisionInput, CharacterModule, CharacterTurn } from "../character-module-registry.js";
import type { ChatRequest } from "../chat-provider.js";
import type { HeldThoughtHint } from "../simple-decision.js";
import { eligibleContribution, exchangeBranch, type ContributionCandidate } from "../character-decision.js";

interface HeldThought { candidate: ContributionCandidate; scope: string; expiresAt: number }
// Simple-route thoughts are ids and enums only: no prose about members is stored.
interface HeldSimpleThought extends HeldThoughtHint { scope: string; expiresAt: number }
export class ThoughtsModule implements CharacterModule {
  public readonly id = "thoughts";
  private readonly reservoir = new Map<string, HeldThought[]>();
  private readonly simple = new Map<string, HeldSimpleThought[]>();
  public reset(guildId?: string, channelId?: string): void {
    const matches = (key: string): boolean => !guildId || (channelId ? key === `${guildId}:${channelId}` : key.startsWith(`${guildId}:`));
    for (const key of this.reservoir.keys()) if (matches(key)) this.reservoir.delete(key);
    for (const key of this.simple.keys()) if (matches(key)) this.simple.delete(key);
  }
  // The newest held thought in this exact scope whose source is still authorized, else nothing.
  public simpleHint(key: string, scope: string, now: number, authorized: ReadonlySet<string>): HeldThoughtHint | null {
    const held = (this.simple.get(key) ?? []).filter((entry) => entry.scope === scope && entry.expiresAt > now && authorized.has(entry.sourceMessageId));
    if (held.length) this.simple.set(key, held); else this.simple.delete(key);
    const newest = held.at(-1);
    return newest ? { sourceMessageId: newest.sourceMessageId, stance: newest.stance, length: newest.length } : null;
  }
  // A different scope (another speaker, recipient or branch) drops what was held for the channel.
  public simpleHold(key: string, scope: string, now: number, holdSeconds: number, thought: HeldThoughtHint): void {
    const kept = (this.simple.get(key) ?? []).filter((entry) => entry.scope === scope && entry.expiresAt > now && entry.sourceMessageId !== thought.sourceMessageId);
    if (this.simple.size >= 256 && !this.simple.has(key)) this.simple.delete(this.simple.keys().next().value!);
    this.simple.set(key, [...kept, { ...thought, scope, expiresAt: now + holdSeconds * 1000 }].slice(-3));
  }
  public simpleClear(key: string): void { this.simple.delete(key); }
  public onDecision(turn: CharacterTurn, input: CharacterDecisionInput): ChatRequest {
    const request = turn.request; const controls = turn.settings.modules.thoughts; const decision = input.decision;
    const key = `${request.guildId}:${request.channelId}`;
    if (!decision || !input.optional || decision.opening !== "clear") { this.reservoir.delete(key); return request; }
    const current = input.burst.at(-1); if (!current) return request;
    const scope = JSON.stringify([exchangeBranch(input.events, current, request.botUserId ?? "bot"), decision.contribution.recipientId, decision.boundary, turn.settings, input.policy]);
    const candidates = decision.thoughts.filter((candidate) => eligibleContribution(candidate, request.interaction === "group_conversation" ? "spontaneous" : "continuation", input.policy) && candidate.recipientId === decision.contribution.recipientId);
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
    return selected ? { ...request, characterContext: [...(request.characterContext ?? []), { moduleId: "thoughts", text: `Reassessed candidate, subordinate to the accepted contribution: ${JSON.stringify(selected.candidate)}` }] } : request;
  }
}
