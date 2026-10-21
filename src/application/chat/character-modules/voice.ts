import type { CharacterModule, CharacterTurn } from "../character-module-registry.js";
import type { ChatResponse } from "../chat-provider.js";
import type { CharacterModuleServices } from "./shared.js";
import { deriveStyleProfile, trimVoice, voiceViolations } from "../character-voice.js";
import { serious, truthfulQuestion } from "./shared.js";
export class VoiceModule implements CharacterModule {
  public readonly id = "voice";
  public constructor(private readonly services: CharacterModuleServices) {}
  public async postProcess(reply: ChatResponse, turn: CharacterTurn): Promise<ChatResponse> {
    if (truthfulQuestion(turn.request.message) || serious(turn.request.message)) return reply;
    const style = deriveStyleProfile(turn.request.characterStyleExamples ?? turn.request.exampleExchanges);
    const substantive = turn.request.triggerMode === "direct" && (turn.request.message.length > 100 || /explain|how to|解釋|說明|教我|説明/iu.test(turn.request.message));
    const trimmed = trimVoice(reply.text) || reply.text;
    const flags = voiceViolations(trimmed, style, substantive);
    const severe = flags.includes("markdown") || flags.includes("length");
    if (turn.settings.modules.voice.strictness === "trim" || !severe) return { ...reply, text: trimmed };
    const repaired = await this.services.repairVoice(turn, trimmed);
    return { ...reply, text: repaired.text.trim() || trimmed };
  }
}
