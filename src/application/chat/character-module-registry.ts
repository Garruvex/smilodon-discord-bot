import type { ChatRequest, ChatResponse, ChannelHistoryMessage, PersonalMemoryExtractionAction } from "./chat-provider.js";
import type { ContributionPolicy } from "./participation-policy.js";
import type { CharacterDecision } from "./character-decision.js";
import { characterDependencies, characterInactiveReason, characterModuleIds, type CharacterCapabilities, type CharacterModuleId, type CharacterSettings } from "./character-settings.js";
import type { GuardedBackgroundContext } from "../context/guarded-background-context.js";

export interface CharacterTurn {
  request: ChatRequest; settings: CharacterSettings; capabilities: CharacterCapabilities; now: number;
  validationNow?: number;
  backgroundContext?: GuardedBackgroundContext;
}
export interface CharacterModule {
  id: CharacterModuleId;
  settingsPath?: string;
  dependsOn?: readonly string[];
  memoryPolicy?: { moduleId: CharacterModuleId; conversationalReads: "module-only" };
  isEnabled?(turn: CharacterTurn): boolean;
  contributeContext?(turn: CharacterTurn): Promise<string | null>;
  postProcess?(reply: ChatResponse, turn: CharacterTurn): Promise<ChatResponse>;
  onObservation?(event: ChannelHistoryMessage, turn: CharacterTurn): Promise<void>;
  onConsolidation?(reply: ChatResponse, turn: CharacterTurn): Promise<void>;
  onDecision?(turn: CharacterTurn, input: CharacterDecisionInput): ChatRequest;
  reset?(guildId?: string, channelId?: string): void;
  extractMemories?(userMessage: string, reply: ChatResponse, turn: CharacterTurn): Promise<readonly PersonalMemoryExtractionAction[] | null>;
}
export interface CharacterDecisionInput {
  decision: CharacterDecision | null; events: readonly ChannelHistoryMessage[]; burst: readonly ChannelHistoryMessage[];
  optional: boolean; local: CharacterDecision["addressing"]; policy: ContributionPolicy;
}
export class CharacterModuleRegistry {
  private readonly modules = new Map<CharacterModuleId, CharacterModule>();
  public constructor(private readonly onError: ((moduleId: CharacterModuleId, error: unknown) => void) | null = null) {}
  public register(module: CharacterModule): void {
    if (this.modules.has(module.id)) throw new Error(`Duplicate character module: ${module.id}`);
    module.settingsPath ??= `character.modules.${module.id}`;
    module.dependsOn ??= characterDependencies[module.id] ?? [];
    module.memoryPolicy ??= { moduleId: module.id, conversationalReads: "module-only" };
    this.modules.set(module.id, module);
  }
  public get<T extends CharacterModule>(id: CharacterModuleId): T | undefined { return this.modules.get(id) as T | undefined; }
  public has(id: CharacterModuleId, visited = new Set<string>()): boolean {
    const module = this.modules.get(id); if (!module || visited.has(id)) return false;
    visited.add(id);
    return (module.dependsOn ?? []).every((dependency) => !characterModuleIds.includes(dependency as CharacterModuleId) || this.has(dependency as CharacterModuleId, new Set(visited)));
  }
  public active(turn: CharacterTurn): readonly CharacterModule[] {
    return [...this.modules.values()].filter((module) => {
      const enabled = this.has(module.id) && !characterInactiveReason(turn.settings, module.id, turn.request.channelId, turn.capabilities) && (module.isEnabled?.(turn) ?? true);
      if (!enabled) module.reset?.(turn.request.guildId, turn.request.channelId);
      return enabled;
    });
  }
  public applyDecision(turn: CharacterTurn, input: CharacterDecisionInput): ChatRequest {
    for (const module of this.active(turn)) if (module.onDecision) {
      // Character hooks contribute context/style; admission belongs to the engine.
      turn.request = module.onDecision(turn, input);
    }
    return turn.request;
  }
  public reset(guildId?: string): void { for (const module of this.modules.values()) module.reset?.(guildId); }
  public async extractMemories(userMessage: string, reply: ChatResponse, turn: CharacterTurn): Promise<readonly PersonalMemoryExtractionAction[] | null> {
    for (const module of this.active(turn)) if (module.extractMemories) {
      const result = await module.extractMemories(userMessage, reply, turn);
      if (result !== null) return result;
    }
    return null;
  }
  public async consolidateModule(id: CharacterModuleId, reply: ChatResponse, turn: CharacterTurn): Promise<void> {
    const module = this.active(turn).find((candidate) => candidate.id === id);
    await module?.onConsolidation?.(reply, turn);
  }
  public async contribute(turn: CharacterTurn): Promise<readonly { moduleId: string; text: string }[]> {
    const context: { moduleId: string; text: string }[] = [];
    for (const module of this.active(turn)) {
      try {
        const text = await module.contributeContext?.(turn);
        if (text) context.push({ moduleId: module.id, text: text.slice(0, turn.settings.modules[module.id].budget) });
      } catch (error) { this.onError?.(module.id, error); }
    }
    return context;
  }
  public async postProcess(reply: ChatResponse, turn: CharacterTurn): Promise<ChatResponse> {
    if (reply.outputOrigin === "tool") return reply;
    for (const module of this.active(turn)) if (module.postProcess) {
      try { reply = await module.postProcess(reply, turn); } catch (error) { this.onError?.(module.id, error); }
    }
    return reply;
  }
  public async consolidate(reply: ChatResponse, turn: CharacterTurn): Promise<void> {
    if (reply.outputOrigin === "tool") return;
    for (const module of this.active(turn)) { try { await module.onConsolidation?.(reply, turn); } catch (error) { this.onError?.(module.id, error); } }
  }
  public async observe(event: ChannelHistoryMessage, turn: CharacterTurn): Promise<void> {
    for (const module of this.active(turn)) { try { await module.onObservation?.(event, turn); } catch (error) { this.onError?.(module.id, error); } }
  }
}
