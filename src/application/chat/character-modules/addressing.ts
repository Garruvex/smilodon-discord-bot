import type { CharacterModule } from "../character-module-registry.js";

export class AddressingModule implements CharacterModule {
  public readonly id = "addressing";
  // Recipient admission belongs to ConversationDecisionEngine. This module
  // remains registered for capability/settings compatibility.
}
