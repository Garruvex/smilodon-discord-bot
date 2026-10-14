import type { CharacterModule } from "../character-module-registry.js";
export class RecallStyleModule implements CharacterModule {
  public readonly id = "recall-style";
  public contributeContext(): Promise<string> { return Promise.resolve("Recall naturally, with a few highlights and an offer to say more. Hedge old/single-source evidence, name the human source of third-party claims, ask when sources conflict, and never invent a shared past."); }
}
