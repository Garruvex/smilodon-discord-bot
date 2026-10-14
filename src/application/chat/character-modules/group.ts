import type { CharacterModule } from "../character-module-registry.js";
export class GroupModule implements CharacterModule {
  public readonly id = "group";
  public contributeContext(): Promise<string> { return Promise.resolve("Use canonical author IDs and observed names. Match the room pace, keep simultaneous topics distinct, avoid dominating, and answer the explicitly chosen target. Never turn an inferred link into a real Discord reply in your account of what happened."); }
}
