import type { CharacterRuntime } from "../../src/application/chat/character-runtime.js";
import type { CharacterPreparedTurn } from "../../src/application/chat/character-runtime.js";
import type { ChatResponse, PersonalMemoryExtractionAction } from "../../src/application/chat/chat-provider.js";
import type { CharacterMemory } from "../../src/application/chat/character-memory.js";
import type { CharacterModuleRegistry } from "../../src/application/chat/character-module-registry.js";

// White-box lifecycle fixtures only. These are intentionally absent from the
// runtime's public API; live features use its guarded operations.
export function characterInternals(runtime: CharacterRuntime): {
  memory: CharacterMemory; registry: CharacterModuleRegistry; prepare: CharacterRuntime["prepare"]; process: CharacterRuntime["process"];
  consolidate: (reply: ChatResponse, prepared: CharacterPreparedTurn) => Promise<void>;
  extractConversationMemories: (message: string, reply: ChatResponse, prepared: CharacterPreparedTurn) => Promise<readonly PersonalMemoryExtractionAction[] | null>;
} {
  const core = runtime as unknown as { memory: CharacterMemory; registry: CharacterModuleRegistry; prepareCore: CharacterRuntime["prepare"]; processCore: CharacterRuntime["process"] };
  return { memory: core.memory, registry: core.registry, prepare: core.prepareCore.bind(runtime), process: core.processCore.bind(runtime),
    consolidate: (reply, prepared) => runtime.stillEligible(prepared) ? core.registry.consolidate(reply, prepared.turn) : Promise.resolve(),
    extractConversationMemories: (message, reply, prepared) => runtime.stillEligible(prepared) ? core.registry.extractMemories(message, reply, prepared.turn) : Promise.resolve(null) };
}
