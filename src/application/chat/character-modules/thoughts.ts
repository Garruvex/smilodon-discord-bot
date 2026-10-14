import type { CharacterDecisionInput, CharacterModule, CharacterTurn } from "../character-module-registry.js";
import type { ChatRequest } from "../chat-provider.js";

interface HeldThought { text: string; sourceId: string; topic: string; expiresAt: number; motivation: number }
export class ThoughtsModule implements CharacterModule {
  public readonly id = "thoughts";
  private readonly reservoir = new Map<string, HeldThought[]>();
  public reset(guildId?: string, channelId?: string): void {
    if (!guildId) { this.reservoir.clear(); return; }
    for (const key of this.reservoir.keys()) if (channelId ? key === `${guildId}:${channelId}` : key.startsWith(`${guildId}:`)) this.reservoir.delete(key);
  }
  public onDecision(turn: CharacterTurn, input: CharacterDecisionInput): { request: ChatRequest; allowed: boolean } {
    let request = turn.request; const decision = input.decision; const controls = turn.settings.modules.thoughts;
    if (!decision || !input.optional) return { request, allowed: true };
    const key = `${request.guildId}:${request.channelId}`;
    const topic = decision.boundary === "earlier" ? input.events[0]?.messageId ?? "" : decision.boundary;
    const sourceIds = new Set([...input.events, ...input.burst].map((event) => event.messageId));
    const held = (this.reservoir.get(key) ?? []).filter((thought) => thought.expiresAt > turn.now && thought.topic === topic && sourceIds.has(thought.sourceId));
    for (const thought of decision.thoughts) if (thought.motivation >= controls.threshold)
      held.push({ text: thought.text, sourceId: thought.sourceMessageId, topic, motivation: thought.motivation, expiresAt: turn.now + controls.holdSeconds * 1000 });
    if (this.reservoir.size >= 256 && !this.reservoir.has(key)) this.reservoir.delete(this.reservoir.keys().next().value!);
    this.reservoir.set(key, held.slice(-3));
    const spontaneous = request.triggerMode === "spontaneous";
    const allowed = !(spontaneous && (controls.shadow || decision.motivation < controls.threshold));
    if (allowed && !controls.shadow && held.length && (!spontaneous || turn.now - (input.burst.at(-1)?.timestampMs ?? turn.now) >= 1000)) {
      request = { ...request, characterContext: [...(request.characterContext ?? []), { moduleId: "thoughts", text: JSON.stringify(held.map((thought) => ({ text: thought.text, sourceId: thought.sourceId }))) }] };
      this.reservoir.delete(key);
    }
    return { request, allowed };
  }
}
