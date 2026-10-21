import type { CharacterRuntime } from "../../src/application/chat/character-runtime.js";
import type { CharacterMemory } from "../../src/application/chat/character-memory.js";
import type { CharacterModuleRegistry } from "../../src/application/chat/character-module-registry.js";

// White-box lifecycle fixtures only. These are intentionally absent from the
// runtime's public API; live features use its guarded operations.
export function characterInternals(runtime: CharacterRuntime): { memory: CharacterMemory; registry: CharacterModuleRegistry } {
  return runtime as unknown as { memory: CharacterMemory; registry: CharacterModuleRegistry };
}
