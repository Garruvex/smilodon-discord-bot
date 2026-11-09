import { describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/application/commands/command.js";
import { CommandResponseVisibility } from "../../src/application/commands/command.js";
import type { ChatTraceStore } from "../../src/application/diagnostics/chat-trace-store.js";
import { ExplainMessageCommand } from "../../src/infrastructure/discord/commands/diagnostics/explain-message-command.js";
import { freshDocument, guildId, memoryProvider } from "../helpers/settings-fixtures.js";
import { diagnosticRecord } from "../helpers/chat-trace-fixtures.js";

const channelId = "222222222222222222"; const messageId = "333333333333333333"; const adminRole = "200000000000000001";
type Source = { author: { id: string }; guildId: string; channelId: string; id: string };
function fixture(): { command: ExplainMessageCommand; context: CommandContext; lookup: ReturnType<typeof vi.fn>; edit: ReturnType<typeof vi.fn>;
  source: Source; roles: Map<string, unknown>; permissions: ReturnType<typeof vi.fn>;
  fetchSource: ReturnType<typeof vi.fn<() => Promise<Source>>>; profiles: ReturnType<typeof memoryProvider>; fetchMember: ReturnType<typeof vi.fn> } {
  const document = freshDocument(); document.features.diagnostics = true; const profiles = memoryProvider(document);
  const roles = new Map<string, unknown>(); const edit = vi.fn(() => Promise.resolve());
  const permissions = vi.fn((): { has: () => boolean } => ({ has: () => true }));
  const source = { guildId, channelId, id: messageId, author: { id: "author" } };
  const fetchSource = vi.fn(() => Promise.resolve(source)); const fetchMember = vi.fn(() => Promise.resolve({ roles: { cache: roles } }));
  const channel = { id: channelId, guildId, isTextBased: (): boolean => true, permissionsFor: permissions, messages: { fetch: fetchSource } };
  const context = { interaction: { guildId, channelId, user: { id: "author" }, options: { getString: () => messageId },
    guild: { channels: { fetch: () => Promise.resolve(channel) }, members: { fetch: fetchMember, fetchMe: () => Promise.resolve({}) } } },
    responses: { reply: edit, edit, defer: () => Promise.resolve() } } as unknown as CommandContext;
  const lookup = vi.fn(() => [{ traceId: "SECRET_TRACE", processRunId: "run", truncated: false, records: [diagnosticRecord({ data: {
    event: "chat.decision.resolved", stage: "generation", interaction: "bare_ping", status: "ready", recovery: "none", decisionId: "SECRET_DECISION", action: "silent", intent: "abstain", reason: "SECRET_MEMBER_RESTRICTION", policyVersion: "p", contextVersion: "c",
  } })] }]);
  return { command: new ExplainMessageCommand({ lookup } as unknown as ChatTraceStore, profiles), context, lookup, edit, source, roles, permissions, fetchSource, profiles, fetchMember };
}

describe("safe message explanations", () => {
  it("is ephemeral and gives an author a redacted outcome after fresh access checks", async () => {
    const f = fixture(); expect(f.command.responseVisibility).toBe(CommandResponseVisibility.Ephemeral); expect(f.command.access.ownerBypass).toBe(false);
    await f.command.execute(f.context);
    expect(f.lookup).toHaveBeenCalledExactlyOnceWith({ guildId, channelId, sourceMessageId: messageId });
    expect(f.fetchMember).toHaveBeenCalledTimes(2); expect(f.fetchSource).toHaveBeenCalledWith({ message: messageId, force: true });
    expect(f.edit).toHaveBeenCalledWith("A valid decision chose silence."); expect(JSON.stringify(f.edit.mock.calls)).not.toContain("SECRET");
  });
  it("does not read traces for another person's message", async () => {
    const f = fixture(); f.source.author.id = "other"; await f.command.execute(f.context);
    expect(f.lookup).not.toHaveBeenCalled(); expect(f.edit).toHaveBeenCalledWith(expect.stringContaining("cannot be explained"));
  });
  it("denies current restricted membership without inspecting retained records", async () => {
    const restricted = "900000000000000001";
    const f = fixture(); f.roles.set(restricted, {}); await f.profiles.update(guildId, { restrictedRoleIds: [restricted] });
    await f.command.execute(f.context); expect(f.lookup).not.toHaveBeenCalled(); expect(f.fetchSource).not.toHaveBeenCalled();
  });
  it("allows a currently configured administrator, without exposing raw timelines", async () => {
    const f = fixture(); f.roles.set(adminRole, {}); f.source.author.id = "other";
    await f.command.execute(f.context); expect(f.lookup).toHaveBeenCalledOnce();
    expect(f.edit).toHaveBeenCalledWith(expect.stringContaining("/settings-participation policy")); expect(JSON.stringify(f.edit.mock.calls)).not.toContain("SECRET");
  });
  it("rejects an administrator whose role is removed while resolving the message", async () => {
    const f = fixture(); f.roles.set(adminRole, {}); f.source.author.id = "other";
    f.fetchSource.mockImplementation(() => { f.roles.clear(); return Promise.resolve(f.source); });
    await f.command.execute(f.context); expect(f.lookup).not.toHaveBeenCalled();
  });
  it.each(["permission", "missing", "scope", "disabled"] as const)("fails closed for %s before inspecting records", async (kind) => {
    const f = fixture();
    if (kind === "permission") f.permissions.mockReturnValue({ has: () => false });
    if (kind === "missing") f.fetchSource.mockRejectedValue(new Error("SECRET_CONTENT"));
    if (kind === "scope") f.source.guildId = "foreign";
    if (kind === "disabled") { const profile = f.profiles.current(); profile.features.diagnostics = false; vi.spyOn(f.profiles, "find").mockReturnValue(profile); }
    await f.command.execute(f.context); expect(f.lookup).not.toHaveBeenCalled(); expect(JSON.stringify(f.edit.mock.calls)).not.toContain("SECRET");
  });
  it("does not fetch a cross-channel message link", async () => {
    const f = fixture(); f.context.interaction.options.getString = (): string => `https://discord.com/channels/${guildId}/444444444444444444/${messageId}`;
    await f.command.execute(f.context); expect(f.fetchSource).not.toHaveBeenCalled(); expect(f.lookup).not.toHaveBeenCalled();
  });
  it.each(["en", "zh-TW", "ja"] as const)("localizes the safe %s outcome", async (language) => {
    const f = fixture(); await f.profiles.update(guildId, { language }); await f.command.execute(f.context);
    expect(String(f.edit.mock.calls[0]?.[0]).length).toBeLessThan(2000); expect(JSON.stringify(f.edit.mock.calls)).not.toContain("SECRET");
  });
});
