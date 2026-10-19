import { describe, expect, it, vi } from "vitest";
import { DiagnosticCommand } from "../../src/infrastructure/discord/commands/diagnostics/diagnostic-command.js";
import { CommandResponseVisibility, type CommandContext } from "../../src/application/commands/command.js";
import type { ChatTraceStore } from "../../src/application/diagnostics/chat-trace-store.js";
import { diagnosticRecord } from "../helpers/chat-trace-fixtures.js";

const guildId = "111111111111111111";
const channelId = "222222222222222222";
const messageId = "333333333333333333";

function setup(reference: string | null = messageId): {
  command: DiagnosticCommand; context: CommandContext; reply: ReturnType<typeof vi.fn>; edit: ReturnType<typeof vi.fn>;
  lookup: ReturnType<typeof vi.fn>; permissions: ReturnType<typeof vi.fn>; fetchChannel: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn(() => Promise.resolve()); const edit = vi.fn(() => Promise.resolve());
  const permissions = vi.fn(() => ({ has: (): boolean => true }));
  const fetchChannel = vi.fn(() => Promise.resolve({ permissionsFor: permissions }));
  const context = { interaction: { guildId, channelId, user: { id: "owner" },
    guild: { channels: { fetch: fetchChannel }, members: {
      fetch: vi.fn(() => Promise.resolve({ id: "owner" })), fetchMe: vi.fn(() => Promise.resolve({ id: "bot" })),
    } }, options: { getString: vi.fn(() => reference) }, client: { guilds: { cache: new Map() } } },
    responses: { reply, edit, defer: vi.fn(() => Promise.resolve()) },
  } as unknown as CommandContext;
  const lookup = vi.fn(() => [{ traceId: "trace", processRunId: "run", truncated: false, records: [diagnosticRecord()] }]);
  const traces: ChatTraceStore = {
    record: () => undefined, lookup,
    status: () => ({ traces: 1, events: 1, bytes: 100, droppedTraces: 0, droppedEvents: 0, expiredTraces: 0, invalidRecords: 0, writeFailures: 0 }),
    forgetGuild: () => Promise.resolve(), excludeSource: () => undefined, flush: () => Promise.resolve(),
  };
  return { command: new DiagnosticCommand(traces, new Set(["owner"])), context, reply, edit, lookup, permissions, fetchChannel };
}

describe("protected diagnostic timeline lookup", () => {
  it("is owner-only/ephemeral and accepts a same-channel message link", async () => {
    const { command, context, edit, lookup, fetchChannel } = setup(`https://discord.com/channels/${guildId}/${channelId}/${messageId}`);
    expect(command.access.ownerOnly).toBe(true);
    expect(command.responseVisibility).toBe(CommandResponseVisibility.Ephemeral);
    await command.execute(context);
    expect(fetchChannel).toHaveBeenCalledWith(channelId, { force: true });
    expect(lookup).toHaveBeenCalledWith({ guildId, channelId, sourceMessageId: messageId });
    expect(edit).toHaveBeenCalledWith(expect.stringContaining("chat.turn.started"));
  });

  it("rechecks the owner's identity before fetching channel information or traces", async () => {
    const { command, context, lookup, fetchChannel, reply } = setup();
    context.interaction.user.id = "other";
    await command.execute(context);
    expect(lookup).not.toHaveBeenCalled(); expect(fetchChannel).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Only a bot owner"));
  });

  it.each([
    `https://discord.com/channels/${guildId}/999999999999999999/${messageId}`,
    `https://discord.com/channels/999999999999999999/${channelId}/${messageId}`,
    `https://example.com/channels/${guildId}/${channelId}/${messageId}`,
    "not-a-message",
  ])("rejects a cross-scope or malformed reference before reading records: %s", async (reference) => {
    const { command, context, lookup, fetchChannel, reply } = setup(reference);
    await command.execute(context);
    expect(lookup).not.toHaveBeenCalled(); expect(fetchChannel).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("this server and channel"));
  });

  it.each(["owner", "bot"])("denies lookup when %s loses current read/history permission", async (denied) => {
    const { command, context, permissions, lookup, edit } = setup();
    permissions.mockImplementation((member: { id: string }) => ({ has: (): boolean => member.id !== denied }));
    await command.execute(context);
    expect(lookup).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledWith(expect.stringContaining("current channel and history access"));
  });

  it("fails closed when permissions cannot be refreshed", async () => {
    const { command, context, fetchChannel, lookup, edit } = setup();
    fetchChannel.mockRejectedValue(new Error("SECRET_PERMISSION_ERROR"));
    await command.execute(context);
    expect(lookup).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledWith(expect.stringContaining("could not be verified"));
    expect(JSON.stringify(edit.mock.calls)).not.toContain("SECRET");
  });

  it("keeps basic runtime diagnostics available without a message argument", async () => {
    const { command, context, reply, lookup } = setup(null);
    await command.execute(context);
    expect(lookup).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0]).toHaveProperty("content", expect.stringContaining("Uptime:"));
  });

  it("does not turn absent or evicted records into a claim that the bot never received a message", async () => {
    const { command, context, lookup, edit } = setup(); lookup.mockReturnValue([]);
    await command.execute(context);
    expect(edit).toHaveBeenCalledWith(expect.stringContaining("does not prove the bot never received it"));
  });

  it("keeps the final outcome visible when the timeline must be shortened", async () => {
    const { command, context, lookup, edit } = setup();
    lookup.mockReturnValue([{ traceId: "trace", processRunId: "run", truncated: true,
      records: [...Array.from({ length: 100 }, () => diagnosticRecord()), diagnosticRecord({ data: {
        event: "chat.turn.completed", outcome: "text_delivered", triggerMode: "direct", durationMs: 10, textDeliveryConfirmed: true,
      } })] }]);
    await command.execute(context);
    expect(edit).toHaveBeenCalledWith(expect.stringContaining("chat.turn.completed: text_delivered"));
    expect(edit).toHaveBeenCalledWith(expect.stringContaining("Partial timeline"));
    expect(String(edit.mock.calls[0]?.[0]).length).toBeLessThan(2000);
  });
});
