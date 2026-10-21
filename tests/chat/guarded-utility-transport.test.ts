import { afterEach, describe, expect, it, vi } from "vitest";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import { approveModelOperation } from "../../src/application/context/approved-model-operation.js";
import { guardModelTransport } from "../../src/application/context/guarded-model-transport.js";
import { HttpDecisionProvider } from "../../src/infrastructure/chat/http-decision-provider.js";
import { guardedFixture } from "../helpers/guarded-context-fixture.js";
import type { StructuredCallOptions } from "../../src/application/chat/chat-provider.js";

afterEach(() => vi.unstubAllGlobals());
async function fixture(): Promise<{ source: ReturnType<typeof guardedFixture>; context: GuardedConversationContext }> {
  const source = guardedFixture();
  return { source, context: await GuardedConversationContext.open(source.port, { count: 0, budget: 0, burstIds: [] }) };
}

describe("mandatory utility transport", () => {
  it("exposes only frozen capabilities and keeps raw clients and credentials inside the facade", () => {
    const raw = { apiKey: "PRIVATE_CREDENTIAL", configuration: { secret: "PRIVATE_CONFIGURATION" },
      inner: { generateCharacterData: (): Promise<unknown> => Promise.resolve({}) }, nativeWebSearchSupported: true,
      generateCharacterData: (): Promise<unknown> => Promise.resolve({}) };
    const transport = guardModelTransport(raw);
    expect(Object.isFrozen(transport)).toBe(true); expect(Object.getPrototypeOf(transport)).toBeNull();
    expect(Object.keys(transport).sort()).toEqual(["generateCharacterData", "nativeWebSearchSupported"]);
    expect(transport.apiKey).toBeUndefined(); expect(transport.configuration).toBeUndefined(); expect(transport.inner).toBeUndefined();
    expect(transport.nativeWebSearchSupported).toBe(true); expect("reply" in transport).toBe(false);
    expect(() => { transport.generateCharacterData = raw.inner.generateCharacterData; }).toThrow();
  });
  it.each(["missing", "callback", "copy", "payload", "purpose", "reuse"])("rejects %s authority before dispatch", async (kind) => {
    const { context } = await fixture(); const call = vi.fn((_first: string, _second?: unknown, _options?: StructuredCallOptions) => Promise.resolve({ text: "ok" }));
    const transport = guardModelTransport({ generateCharacterData: call, analyzeUserCustomization: call });
    const schema = { type: "object" }; const receipt = approveModelOperation(context, "generateCharacterData", ["admitted", schema]);
    if (kind === "reuse") await transport.generateCharacterData("admitted", schema, receipt);
    call.mockClear();
    const task = kind === "purpose" ? transport.analyzeUserCustomization("admitted", receipt) :
      transport.generateCharacterData(kind === "payload" ? "appended private content" : "admitted", schema,
        kind === "missing" ? undefined : kind === "callback" ? { beforeAttempt: (): Promise<void> => Promise.resolve() } : kind === "copy" ? { ...receipt } : receipt);
    await expect(task).rejects.toBeInstanceOf(SocialOutputSuppressed); expect(call).not.toHaveBeenCalled();
  });
  it("checks the source before dispatch and inside provider retries", async () => {
    const { context, source } = await fixture(); const network = vi.fn();
    const transport = guardModelTransport({ generateCharacterData: async (_prompt: string, _schema: Record<string, unknown>, options?: StructuredCallOptions): Promise<unknown> => {
      source.setPolicy(false); await options?.beforeAttempt?.(); network(); return {};
    } });
    await expect(transport.generateCharacterData("admitted", {}, approveModelOperation(context, "generateCharacterData", ["admitted", {}])))
      .rejects.toBeInstanceOf(SocialOutputSuppressed); expect(network).not.toHaveBeenCalled();
  });
  it("does not expose a result after revocation during the model call", async () => {
    const { context, source } = await fixture();
    const transport = guardModelTransport({ generateCharacterData: (_prompt: string, _schema: Record<string, unknown>, _options?: StructuredCallOptions): Promise<unknown> => { source.setPolicy(false); return Promise.resolve({ secret: "stale result" }); } });
    await expect(transport.generateCharacterData("admitted", {}, approveModelOperation(context, "generateCharacterData", ["admitted", {}])))
      .rejects.toBeInstanceOf(SocialOutputSuppressed);
  });
  it("snapshots schema and binary bytes before asynchronous checks", async () => {
    const { context } = await fixture(); const reference = { contentType: "image/png", data: Buffer.from("approved") };
    const capture = vi.fn((_prompt: string, value: typeof reference, _options?: StructuredCallOptions) => Promise.resolve(value.data.toString()));
    const transport = guardModelTransport({ generateReferenceImage: capture });
    const receipt = approveModelOperation(context, "generateReferenceImage", ["draw", reference]);
    const task = transport.generateReferenceImage("draw", reference, receipt); reference.data.fill(88);
    await expect(task).resolves.toBe("approved"); expect(capture.mock.calls[0]![1].contentType).toBe("image/png");
  });
  it("captures the actual HTTP payload and blocks unregistered requests without network calls", async () => {
    const { context } = await fixture();
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 })));
    vi.stubGlobal("fetch", fetch);
    const transport = guardModelTransport(new HttpDecisionProvider({ baseUrl: "https://fixture.invalid/v1", apiKey: "synthetic", model: "fixture" }));
    await expect(transport.generateCharacterData("unapproved", {})).rejects.toBeInstanceOf(SocialOutputSuppressed); expect(fetch).not.toHaveBeenCalled();
    await expect(transport.generateCharacterData("admitted", {}, approveModelOperation(context, "generateCharacterData", ["admitted", {}]))).resolves.toEqual({ ok: true });
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as { messages: { content: string }[] };
    expect(body.messages).toEqual([{ role: "system", content: "admitted" }]);
  });
});
