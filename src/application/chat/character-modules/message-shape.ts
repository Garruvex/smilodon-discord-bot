import type { CharacterModule, CharacterTurn } from "../character-module-registry.js";
import type { ChatResponse } from "../chat-provider.js";
import { shapeMessages } from "../character-voice.js";
import { serious } from "./shared.js";
export class MessageShapeModule implements CharacterModule {
  public readonly id = "message-shape";
  public postProcess(reply: ChatResponse, turn: CharacterTurn): Promise<ChatResponse> { return Promise.resolve(turn.request.triggerMode === "direct" || serious(turn.request.message) ? reply : shapeMessages(reply, turn.settings.modules["message-shape"].maxMessages, turn.settings.modules["message-shape"].maxDelayMs)); }
}
