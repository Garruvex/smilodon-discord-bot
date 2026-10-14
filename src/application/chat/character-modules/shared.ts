import { createHash } from "node:crypto";
import type { ChatRequest, ChatProvider } from "../chat-provider.js";
import type { CharacterModuleId } from "../character-settings.js";
import type { CharacterTurn } from "../character-module-registry.js";
import type { CharacterMemory } from "../character-memory.js";
import type { CharacterCallbacks } from "../character-callbacks.js";
import type { MemoryRepository, RepositoryIngestInput, CandidateQuery } from "../../memory/memory.js";
import type { GuildConfiguration } from "../../../config/guild-configuration.js";
export const serious = (text: string): boolean => /suicid|self.harm|kill myself|自殺|自残|自殘|想死|不想活|死にたい|depress|panic|grief|mourning|funeral|passed away|崩潰|焦慮|亡くな|つらい|虐待|abuse|診斷|診断|medical|醫療|法律|legal|financial|投資|詐騙/iu.test(text);
export const truthfulQuestion = (text: string): boolean => /(?:are you|你是|你是不是|你到底是|あなたは).*(?:bot|robot|real person|human|機器人|真人|人間|ボット)/iu.test(text);
export const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
export const personaFingerprint = (request: ChatRequest): string => request.characterPersonaHash ?? hash(JSON.stringify([request.personality, request.personaLore]));
export interface CharacterModuleServices {
  memory: CharacterMemory; repository: MemoryRepository; replyProvider: ChatProvider; callbacks: CharacterCallbacks; hasUtility: boolean;
  profile(turn: CharacterTurn): GuildConfiguration;
  query(turn: CharacterTurn): CandidateQuery;
  base(turn: CharacterTurn, slot: string, statement: string): Omit<RepositoryIngestInput, "guildId" | "moduleId">;
  ready(turn: CharacterTurn, id: CharacterModuleId): boolean;
  generate(prompt: string, schema?: Record<string, unknown>): Promise<unknown>;
  text(prompt: string): Promise<string | null>;
}
