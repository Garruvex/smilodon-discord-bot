import { describe, expect, it, vi } from "vitest";
import { approveConversationRequest, repairConversationRequest } from "../../src/application/context/approved-conversation-request.js";
import { ConversationModelGateway } from "../../src/application/context/conversation-model-gateway.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import { guardedFixture } from "../helpers/guarded-context-fixture.js";
import { configurationFixture } from "../helpers/configuration-context-fixture.js";
import { decisionRequest, decisionResponse } from "../helpers/conversation-decision-fixtures.js";
import type { ChatRequest } from "../../src/application/chat/chat-provider.js";
import { buildChatContext, buildChatInstructions } from "../../src/infrastructure/chat/chat-structured-output.js";

async function fixture(): Promise<{ input: ChatRequest; source: ReturnType<typeof guardedFixture>; revokeConfiguration: () => void }> {
  const source = guardedFixture(); let current = true;
  const contextLease = await GuardedConversationContext.open(source.port, { count: 0, budget: 0, burstIds: [] });
  const configurationContext = await configurationFixture("Persona", "persona", () => current, "guild");
  return { source, revokeConfiguration: (): void => { current = false; }, input: decisionRequest({ guildId: "guild", channelId: "channel",
    contextLease, configurationContext, personality: "Persona", currentUser: { id: "alice", displayName: "Alice", roleNames: [] } }) };
}

describe("registered conversation request boundary", () => {
  it.each([false, true])("reapproves role sets through generation and repair (populated=%s)", async (populated) => {
    const { input } = await fixture();
    input.musicControllerRoleIds = new Set(populated ? ["controller"] : []);
    input.musicBotAdministratorRoleIds = new Set(populated ? ["administrator"] : []);
    const parent = approveConversationRequest(input);
    const generation = approveConversationRequest({ ...parent, personaLore: [] });
    const repair = repairConversationRequest(generation, "draft", "notes");
    for (const request of [generation, repair]) {
      expect([...request.musicControllerRoleIds!]).toEqual(populated ? ["controller"] : []);
      expect([...request.musicBotAdministratorRoleIds!]).toEqual(populated ? ["administrator"] : []);
      expect("add" in request.musicControllerRoleIds!).toBe(false);
      const reply = vi.fn(() => Promise.resolve(decisionResponse()));
      await new ConversationModelGateway({ reply }).reply(request);
      expect(reply).toHaveBeenCalledOnce();
    }
  });
  it.each(["raw", "copy"] as const)("rejects a %s request despite a valid source lease", async (kind) => {
    const { input } = await fixture(); const reply = vi.fn(() => Promise.resolve(decisionResponse()));
    const request = kind === "copy" ? { ...approveConversationRequest(input) } : input;
    await expect(new ConversationModelGateway({ reply }).reply(request)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(reply).not.toHaveBeenCalled();
  });
  it("copies and freezes nested model data and pins callback bindings", async () => {
    const { input } = await fixture(); const original = vi.fn(() => Promise.resolve()); input.beforeModelAttempt = original;
    const request = approveConversationRequest(input); input.currentUser.displayName = "UNAPPROVED_APPEND";
    input.beforeModelAttempt = (): Promise<void> => Promise.reject(new Error("replaced callback"));
    expect(request.currentUser.displayName).toBe("Alice");
    expect(() => { request.currentUser.displayName = "modified"; }).toThrow();
    expect(() => { request.message = "appended message"; }).toThrow();
    await request.beforeModelAttempt!(); expect(original).toHaveBeenCalledOnce();
  });
  it("keeps tool definitions immutable and functional execution state application-owned", async () => {
    const { input } = await fixture(); let executed = false;
    const parameters = { type: "object", properties: { value: { type: "string" } } };
    input.enabledTools = [{ name: "reviewed_fixture", description: "A tool", parameters, execute: (): Promise<{ content: string }> => { executed = true; return Promise.resolve({ content: "ok" }); } }];
    const request = approveConversationRequest(input, () => executed); parameters.properties.value.type = "UNAPPROVED";
    expect(request.enabledTools![0]!.parameters).toEqual({ type: "object", properties: { value: { type: "string" } } });
    expect(() => { request.functionalToolExecuted = true; }).toThrow();
    expect(request.functionalToolExecuted).toBe(false);
    await request.enabledTools![0]!.execute({}, {} as never); expect(request.functionalToolExecuted).toBe(true);
  });
  it("does not expose mutable role-set storage through iteration callbacks", async () => {
    const { input } = await fixture(); const roles = new Set(["controller"]); input.musicControllerRoleIds = roles;
    const request = approveConversationRequest(input); roles.add("administrator");
    expect([...request.musicControllerRoleIds!]).toEqual(["controller"]);
    request.musicControllerRoleIds!.forEach((_value, _key, set) => {
      expect("add" in set).toBe(false); expect(Object.isFrozen(set)).toBe(true);
    });
  });
  it("keeps post-approval additions out of the final serialized provider payload", async () => {
    const { input } = await fixture(); input.characterContext = [{ moduleId: "fixture", text: "AUTHORIZED_STYLE" }];
    const request = approveConversationRequest(input);
    input.characterContext[0]!.text = "UNAPPROVED_APPEND";
    input.message = "UNAPPROVED_MESSAGE";
    const payloads: string[] = [];
    const reply = vi.fn(async (attempt: ChatRequest) => {
      for (let index = 0; index < 2; index++) {
        await attempt.beforeModelAttempt!();
        payloads.push(buildChatInstructions(attempt, "safety") + buildChatContext(attempt));
      }
      return decisionResponse();
    });
    await new ConversationModelGateway({ reply }).reply(request);
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) { expect(payload).toContain("AUTHORIZED_STYLE"); expect(payload).not.toContain("UNAPPROVED"); }
  });
  it.each(["source", "configuration"] as const)("revalidates %s on an actual retry", async (changed) => {
    const { input, source, revokeConfiguration } = await fixture(); const request = approveConversationRequest(input);
    const external = vi.fn();
    const reply = vi.fn(async (attempt: ChatRequest) => {
      await attempt.beforeModelAttempt!(); external();
      if (changed === "source") source.denied.add("current"); else revokeConfiguration();
      await attempt.beforeModelAttempt!(); external(); return decisionResponse();
    });
    await expect(new ConversationModelGateway({ reply }).reply(request)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(external).toHaveBeenCalledOnce();
  });
  it("derives text-only repairs without accepting an unregistered parent", async () => {
    const { input } = await fixture();
    expect(() => repairConversationRequest(input, "draft", "notes")).toThrow(SocialOutputSuppressed);
    const parent = approveConversationRequest({ ...input, webSearchMode: "auto", imageGenerationEnabled: true, historyReactionsEnabled: true });
    const repair = repairConversationRequest(parent, "draft", "notes");
    expect(repair).toMatchObject({ attributionRepair: { draft: "draft", notes: "notes" }, personality: "Persona", webSearchMode: "off",
      imageGenerationEnabled: false, historyReactionsEnabled: false, enabledTools: [] });
    expect(parent.webSearchMode).toBe("auto");
    const reply = vi.fn(() => Promise.resolve(decisionResponse())); await new ConversationModelGateway({ reply }).reply(repair);
    expect(reply).toHaveBeenCalledOnce();
  });
});
