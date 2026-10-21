import type { ChatRequest } from "../chat/chat-provider.js";
import { isGuardedContext } from "../chat/guarded-conversation-context.js";
import { isConfigurationContext } from "./guarded-configuration-context.js";
import { SocialOutputSuppressed } from "../chat/message-origin-store.js";
import { immutableSnapshot } from "./immutable-snapshot.js";
import { isEvaluationContext, type GuardedEvaluationContext } from "./guarded-evaluation-context.js";

const requests = new WeakSet<object>();
const execution = new WeakMap<object, () => boolean>();
const evaluationRequests = new WeakSet<object>();
const references = new Set(["contextLease", "configurationContext", "turnSignal", "beforeModelAttempt", "musicResolveAccessSubjectFields"]);
const roleSets = new Set(["musicControllerRoleIds", "musicBotAdministratorRoleIds"]);

// Only the source-owned assembler can issue initial requests. Derivation is
// restricted to closed repair operations in the model gateway. Copies have no
// authority, even when they retain a valid source lease.
export function approveConversationRequest(input: ChatRequest, toolExecuted: () => boolean = () => false): ChatRequest {
  if (!isGuardedContext(input.contextLease) || !isConfigurationContext(input.configurationContext, "persona") ||
      input.contextLease.scope.guildId !== input.guildId || input.contextLease.scope.channelId !== input.channelId ||
      input.configurationContext.scope.guildId !== input.guildId || input.configurationContext.material.text !== input.personality)
    throw new SocialOutputSuppressed();
  const context = input.contextLease; const configuration = input.configurationContext;
  const beforeAttempt = input.beforeModelAttempt; const guildId = input.guildId;
  const projection = Object.fromEntries(Object.entries(input).filter(([key]) => !references.has(key) && key !== "enabledTools" && key !== "functionalToolExecuted")
    // A prior approval exposes ReadonlySet views, not native Sets. Rebuild
    // these known fields from their values rather than cloning bound methods.
    .map(([key, value]) => [key, value != null && roleSets.has(key) ? readonlySet(value as ReadonlySet<unknown>) :
      value instanceof Set ? readonlySet(value) : immutableSnapshot(value)]));
  const request = { ...projection,
    contextLease: input.contextLease, configurationContext: input.configurationContext,
    ...(input.turnSignal ? { turnSignal: input.turnSignal } : {}),
    ...(input.musicResolveAccessSubjectFields ? { musicResolveAccessSubjectFields: input.musicResolveAccessSubjectFields } : {}),
    enabledTools: Object.freeze((input.enabledTools ?? []).map((tool) => Object.freeze({ name: tool.name, description: tool.description,
      parameters: immutableSnapshot(tool.parameters), ...(tool.outputKind ? { outputKind: tool.outputKind } : {}), execute: tool.execute.bind(tool) }))),
    beforeModelAttempt: async (): Promise<void> => {
      await beforeAttempt?.();
      await configuration.check({ kind: "persona", guildId, ownerUserId: null });
      if (!await context.validate()) throw new SocialOutputSuppressed();
    },
  } as ChatRequest;
  Object.defineProperty(request, "functionalToolExecuted", { get: toolExecuted, enumerable: true });
  requests.add(request); execution.set(request, toolExecuted); return Object.freeze(request);
}

function readonlySet(values: ReadonlySet<unknown>): ReadonlySet<unknown> {
  const copy = new Set([...values].map((value) => immutableSnapshot(value)));
  const view: ReadonlySet<unknown> = Object.freeze({ size: copy.size, has: copy.has.bind(copy), values: copy.values.bind(copy), keys: copy.keys.bind(copy),
    entries: copy.entries.bind(copy), forEach: (callback: (value: unknown, key: unknown, set: ReadonlySet<unknown>) => void, thisArg?: unknown): void => {
      for (const value of copy) callback.call(thisArg, value, value, view);
    }, [Symbol.iterator]: copy[Symbol.iterator].bind(copy) });
  return view;
}

export function requireApprovedConversationRequest(request: ChatRequest): void {
  if (!requests.has(request)) throw new SocialOutputSuppressed();
}

// Only the closed configuration probe assembler issues these. It does not
// inherit conversation authority, nor authorize learned participant state.
export function approveEvaluationRequest(context: GuardedEvaluationContext, input: ChatRequest): ChatRequest {
  if (!isEvaluationContext(context) || input.guildId !== context.scope.guildId || input.channelId !== context.scope.channelId ||
      input.message !== context.question || input.personality !== context.persona.material.text || input.currentUser.id !== "synthetic-reviewer" ||
      input.contextLease || input.recentHistory.length || input.channelHistory.length || input.replyChain.length || input.memories.length ||
      input.guildKnowledge.length || input.causalChains.length || input.mentionedUsers.length || input.images.length || input.enabledTools?.length ||
      input.webSearchMode !== "off" || input.imageGenerationEnabled || input.personaDrift || input.userCustomization || input.birthday) throw new SocialOutputSuppressed();
  const beforeAttempt = input.beforeModelAttempt;
  const { beforeModelAttempt: _before, ...material } = input;
  const request: ChatRequest = Object.freeze({ ...immutableSnapshot(material), beforeModelAttempt: async (): Promise<void> => {
    await context.check(); await beforeAttempt?.();
  } });
  evaluationRequests.add(request); return request;
}

export function requireApprovedModelReply(request: ChatRequest): void {
  if (!requests.has(request) && !evaluationRequests.has(request)) throw new SocialOutputSuppressed();
}

export function repairConversationRequest(request: ChatRequest, draft: string, notes: string): ChatRequest {
  requireApprovedConversationRequest(request);
  return approveConversationRequest({ ...request, attributionRepair: { draft, notes }, enabledTools: [], webSearchMode: "off",
    imageGenerationEnabled: false, historyReactionsEnabled: false }, execution.get(request));
}
