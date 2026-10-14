import type { CharacterDecisionInput, CharacterModule, CharacterTurn } from "../character-module-registry.js";
import type { ChatRequest } from "../chat-provider.js";

export class AddressingModule implements CharacterModule {
  public readonly id = "addressing";
  public onDecision(turn: CharacterTurn, input: CharacterDecisionInput): { request: ChatRequest; allowed: boolean } {
    if (!input.optional || turn.settings.modules.addressing.shadow) return { request: turn.request, allowed: true };
    const addressing = input.decision?.addressing ?? input.local;
    return { request: turn.request, allowed: addressing !== "unclear" && !(turn.request.triggerMode === "continuation" && addressing === "others") };
  }
}
