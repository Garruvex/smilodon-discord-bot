import { describe, expect, it, vi } from "vitest";

import { MemoryCommand } from "../../src/infrastructure/discord/commands/common/memory-command.js";
import type { ChatStateStore } from "../../src/application/chat/chat-state-store.js";
import type { CommandContext } from "../../src/application/commands/command.js";
import { MemberProfileService } from "../../src/application/members/member-profile-service.js";

function makeContext(options: {
  subcommand: string;
  id?: string | null;
  all?: boolean | null;
}): { context: CommandContext; reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn().mockResolvedValue(undefined);
  const context = {
    interaction: {
      guildId: "guild",
      user: { id: "user" },
      options: {
        getSubcommand: () => options.subcommand,
        getString: () => options.id ?? null,
        getBoolean: () => options.all ?? null,
      },
    },
    logger: {} as never,
    responses: { reply } as never,
  } as unknown as CommandContext;
  return { context, reply };
}

describe("MemoryCommand", () => {
  it("lists stored memories with truncated ids", async () => {
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({
        exchanges: [],
        memories: [{
          id: "abcdefgh-1234", assertedByUserId: "user", subjectUserId: "user",
          topic: "preference", slot: "food.fruit", statement: "likes green apples", updatedAt: 0,
        }],
      }),
      commitSuccessfulExchange: () => Promise.resolve(),
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
    const command = new MemoryCommand(store, new MemberProfileService(store, null, null));
    const { context, reply } = makeContext({ subcommand: "list" });

    await command.execute(context);
    expect(reply).toHaveBeenCalledOnce();
    const [message] = reply.mock.calls[0] as [string];
    expect(message).toContain("abcdefgh");
    expect(message).toContain("preference.food.fruit");
    expect(message).toContain("likes green apples");
  });

  it("reports when there is nothing remembered", async () => {
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange: () => Promise.resolve(),
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
    const command = new MemoryCommand(store, new MemberProfileService(store, null, null));
    const { context, reply } = makeContext({ subcommand: "list" });

    await command.execute(context);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("don't have anything remembered"));
  });

  it("forgets a specific memory by matching id prefix", async () => {
    const forgetMemory = vi.fn().mockResolvedValue(true);
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({
        exchanges: [],
        memories: [{
          id: "abcdefgh-1234", assertedByUserId: "user", subjectUserId: "user",
          topic: "preference", slot: "food.fruit", statement: "likes green apples", updatedAt: 0,
        }],
      }),
      commitSuccessfulExchange: () => Promise.resolve(),
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory,
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
    const command = new MemoryCommand(store, new MemberProfileService(store, null, null));
    const { context, reply } = makeContext({ subcommand: "forget", id: "abcdefgh" });

    await command.execute(context);
    expect(forgetMemory).toHaveBeenCalledWith("guild", "user", "abcdefgh-1234");
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Forgot: preference.food.fruit"));
  });

  it("forgets everything when all is true", async () => {
    const forgetAllMemories = vi.fn().mockResolvedValue(3);
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange: () => Promise.resolve(),
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories,
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
    const command = new MemoryCommand(store, new MemberProfileService(store, null, null));
    const { context, reply } = makeContext({ subcommand: "forget", all: true });

    await command.execute(context);
    expect(forgetAllMemories).toHaveBeenCalledWith("guild", "user");
    expect(reply).toHaveBeenCalledWith("Forgot 3 memories.");
  });

  it("reports the current dm-notes setting when no value is given", async () => {
    const getDmNotesEnabled = vi.fn().mockResolvedValue(true);
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange: () => Promise.resolve(),
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled,
      setDmNotesEnabled: vi.fn(),
    };
    const command = new MemoryCommand(store, new MemberProfileService(store, null, null));
    const { context, reply } = makeContext({ subcommand: "notes" });

    await command.execute(context);
    expect(getDmNotesEnabled).toHaveBeenCalledWith("guild", "user");
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("currently DMed to you"));
  });

  it("turns dm notes off when dm:false is given", async () => {
    const setDmNotesEnabled = vi.fn().mockResolvedValue(undefined);
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange: () => Promise.resolve(),
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled,
    };
    const command = new MemoryCommand(store, new MemberProfileService(store, null, null));
    const { context, reply } = makeContext({ subcommand: "notes", all: false });

    await command.execute(context);
    expect(setDmNotesEnabled).toHaveBeenCalledWith("guild", "user", false);
    expect(reply).toHaveBeenCalledWith("I won't DM you notes anymore.");
  });

  it("asks for an id or all when forget is called with neither", async () => {
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange: () => Promise.resolve(),
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
    const command = new MemoryCommand(store, new MemberProfileService(store, null, null));
    const { context, reply } = makeContext({ subcommand: "forget" });

    await command.execute(context);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Provide `id:"));
  });
});
