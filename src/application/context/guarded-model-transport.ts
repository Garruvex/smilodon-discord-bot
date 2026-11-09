import type { ChatRequest, StructuredCallOptions } from "../chat/chat-provider.js";
import { consumeModelOperation, snapshotModelArguments, type UtilityOperation } from "./approved-model-operation.js";
import { requireApprovedModelReply } from "./approved-conversation-request.js";
import { checkModelAdmission } from "./model-admission-diagnostics.js";
import type { DiagnosticLogger } from "../diagnostics/chat-diagnostics.js";

const arity: Readonly<Record<UtilityOperation, number>> = Object.freeze({ generateCharacterData: 2, summarizeDroppedExchanges: 2,
  summarizeReplyChainOverflow: 1, extractPersonalMemories: 3, evolvePersonaDrift: 2, summarizeChannelMessages: 2,
  analyzeUserCustomization: 1, compilePersonaBundle: 1, classifyMemoryConflict: 2, generateReferenceImage: 2, verifyAttribution: 3 });

// Expose only model capabilities. Raw clients, credentials, constructors and
// private transport fields never leave this frozen facade. Bound methods keep
// the raw receiver inside the closure, including provider-internal retries.
export function guardModelTransport<T extends object>(provider: T, logger: DiagnosticLogger | null = null): T {
  const facade: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (Reflect.get(provider, "decisionProtocol") === "openai-decisions") facade.decisionProtocol = "openai-decisions";
  for (const key of ["nativeWebSearchSupported", "applicationToolsSupported", "imageGenerationSupported"]) {
    const value: unknown = Reflect.get(provider, key); if (typeof value === "boolean") facade[key] = value;
  }
  const reply: unknown = Reflect.get(provider, "reply");
  if (typeof reply === "function") facade.reply = async (request: ChatRequest, ...rest: unknown[]): Promise<unknown> => {
    await checkModelAdmission(logger, "reply", "approval", () => requireApprovedModelReply(request));
    await checkModelAdmission(logger, "reply", "source", () => request.beforeModelAttempt!());
    const result: unknown = await Reflect.apply(reply, provider, [request, ...rest]);
    await checkModelAdmission(logger, "reply", "result", () => request.beforeModelAttempt!()); return result;
  };
  for (const method of Object.keys(arity) as UtilityOperation[]) {
    const value: unknown = Reflect.get(provider, method); if (typeof value !== "function") continue;
    facade[method] = async (...input: unknown[]): Promise<unknown> => {
      const count = arity[method];
      const { args, options } = await checkModelAdmission(logger, method, "approval", () => {
        const args = snapshotModelArguments(input.slice(0, count));
        return { args, options: consumeModelOperation(method, args, input[count] as StructuredCallOptions | (() => Promise<void>) | undefined) };
      });
      const beforeAttempt = (): Promise<void> => checkModelAdmission(logger, method, "source", () => options.beforeAttempt!());
      await beforeAttempt();
      const result: unknown = await Reflect.apply(value, provider, [...args, method === "verifyAttribution" ? beforeAttempt : { ...options, beforeAttempt }]);
      await checkModelAdmission(logger, method, "result", () => options.beforeAttempt!()); return result;
    };
  }
  return Object.freeze(facade) as T;
}
