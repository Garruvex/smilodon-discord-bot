import type { CharacterModule } from "../character-module-registry.js";
import type { CharacterModuleServices } from "./shared.js";
import { CanonModule } from "./canon.js";
import { MoodModule } from "./mood.js";
import { DailySketchModule } from "./daily-sketch.js";
import { RelationshipsModule } from "./relationships.js";
import { CallbackPlanningModule } from "./callbacks.js";
import { RecallStyleModule } from "./recall-style.js";
import { GroupModule } from "./group.js";
import { VoiceModule } from "./voice.js";
import { MessageShapeModule } from "./message-shape.js";
import { ThoughtsModule } from "./thoughts.js";
import { FadingModule } from "./fading.js";
import { EvaluationModule } from "./evaluation.js";

// Composition is the only place that chooses which modules ship. Modules
// own their hooks and state; the runtime supplies shared capabilities.
export function createCharacterModules(services: CharacterModuleServices): readonly CharacterModule[] {
  return [new CanonModule(services), new MoodModule(services), new DailySketchModule(services), new RelationshipsModule(services),
    new RecallStyleModule(), new GroupModule(), new VoiceModule(services), new MessageShapeModule(), new CallbackPlanningModule(services),
    new ThoughtsModule(), new FadingModule(), new EvaluationModule()];
}
