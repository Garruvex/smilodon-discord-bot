import type { CharacterModule } from "../character-module-registry.js";
// Lifecycle work uses the memory scorer / evaluation scheduler, not prompt hooks.
export class EvaluationModule implements CharacterModule { public readonly id = "evaluation"; }
