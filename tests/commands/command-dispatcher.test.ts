import type {
  ChatInputCommandInteraction,
  MessageContextMenuCommandInteraction,
} from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AccessPolicyService } from "../../src/application/access/access-policy-service.js";
import { CommandDispatcher } from "../../src/application/commands/command-dispatcher.js";
import { CommandRegistry } from "../../src/application/commands/command-registry.js";
import {
  CommandModule,
  type BotCommand,
  type CommandContext,
} from "../../src/application/commands/command.js";
import type { Language } from "../../src/application/i18n/language.js";
import { texts } from "../../src/application/i18n/texts.js";
import { MusicRateLimitError } from "../../src/application/music/music-errors.js";
import { publicAccessPolicy } from "../../src/domain/access/access-policy.js";

class ChatInputTestCommand implements BotCommand {
  public readonly definition = { name: "shared", description: "Chat input command." } as const;
  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;

  public constructor(private readonly executeSpy: () => void) {}

  public execute(_context: CommandContext): Promise<void> {
    this.executeSpy();
    return Promise.resolve();
  }
}

class MessageContextTestCommand implements BotCommand<MessageContextMenuCommandInteraction> {
  public readonly definition = { type: "messageContextMenu", name: "shared" } as const;
  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;

  public constructor(private readonly executeSpy: () => void) {}

  public execute(_context: CommandContext<MessageContextMenuCommandInteraction>): Promise<void> {
    this.executeSpy();
    return Promise.resolve();
  }
}

type TestCommand = BotCommand | BotCommand<MessageContextMenuCommandInteraction>;

function dispatcherWith(commands: readonly TestCommand[]): CommandDispatcher {
  const registry = new CommandRegistry();
  for (const command of commands) registry.register(command);

  const accessPolicyService = {
    evaluate: vi.fn(() => ({ allowed: true as const })),
  } as unknown as AccessPolicyService;
  const child = vi.fn();
  const logger = { child } as unknown as Logger;
  child.mockReturnValue(logger);

  return new CommandDispatcher(registry, accessPolicyService, logger);
}

describe("CommandDispatcher", () => {
  it("routes commands with the same name by interaction type", async () => {
    const chatInputExecute = vi.fn();
    const messageContextExecute = vi.fn();
    const dispatcher = dispatcherWith([
      new ChatInputTestCommand(chatInputExecute),
      new MessageContextTestCommand(messageContextExecute),
    ]);
    const interaction = {
      commandName: "shared",
      isMessageContextMenuCommand: () => true,
      user: { id: "user-1" },
      guildId: "guild-1",
      channelId: "channel-1",
    } as unknown as MessageContextMenuCommandInteraction;

    await dispatcher.dispatch(interaction);

    expect(messageContextExecute).toHaveBeenCalledOnce();
    expect(chatInputExecute).not.toHaveBeenCalled();
  });

  it("defaults chat-input interactions to the chat-input command", async () => {
    const chatInputExecute = vi.fn();
    const messageContextExecute = vi.fn();
    const dispatcher = dispatcherWith([
      new ChatInputTestCommand(chatInputExecute),
      new MessageContextTestCommand(messageContextExecute),
    ]);
    const interaction = {
      commandName: "shared",
      isMessageContextMenuCommand: () => false,
      user: { id: "user-1" },
      guildId: "guild-1",
      channelId: "channel-1",
    } as unknown as ChatInputCommandInteraction;

    await dispatcher.dispatch(interaction);

    expect(chatInputExecute).toHaveBeenCalledOnce();
    expect(messageContextExecute).not.toHaveBeenCalled();
  });
});

describe("CommandDispatcher language", () => {
  class CapturingCommand implements BotCommand {
    public readonly definition = { name: "capture", description: "Captures its context." } as const;
    public readonly module = CommandModule.Common;
    public readonly access = publicAccessPolicy;
    public readonly seen: CommandContext[] = [];
    public failWith: Error | null = null;

    public execute(context: CommandContext): Promise<void> {
      this.seen.push(context);
      return this.failWith ? Promise.reject(this.failWith) : Promise.resolve();
    }
  }

  function setup(languageFor: (guildId: string | null) => Language): {
    dispatcher: CommandDispatcher;
    command: CapturingCommand;
  } {
    const registry = new CommandRegistry();
    const command = new CapturingCommand();
    registry.register(command);
    const accessPolicyService = {
      evaluate: vi.fn(() => ({ allowed: true as const })),
    } as unknown as AccessPolicyService;
    const logger = { child: () => logger, error: vi.fn() } as unknown as Logger;
    return { dispatcher: new CommandDispatcher(registry, accessPolicyService, logger, languageFor), command };
  }

  function interaction(guildId: string | null): ChatInputCommandInteraction & { reply: ReturnType<typeof vi.fn> } {
    return {
      commandName: "capture",
      isMessageContextMenuCommand: () => false,
      user: { id: "user-1" },
      guildId,
      channelId: "channel-1",
      deferred: false,
      replied: false,
      reply: vi.fn(() => Promise.resolve()),
    } as unknown as ChatInputCommandInteraction & { reply: ReturnType<typeof vi.fn> };
  }

  it("gives the command the server's language, re-read on every interaction", async () => {
    let configured: Language = "ja";
    const languageFor = vi.fn(() => configured);
    const { dispatcher, command } = setup(languageFor);

    await dispatcher.dispatch(interaction("guild-1"));
    configured = "zh-TW";
    await dispatcher.dispatch(interaction("guild-1"));

    expect(languageFor).toHaveBeenCalledWith("guild-1");
    expect(command.seen[0]!.text).toBe(texts.ja);
    expect(command.seen[1]!.text).toBe(texts["zh-TW"]);
  });

  it("uses English when nothing resolves a language (DMs, tests)", async () => {
    const registry = new CommandRegistry();
    const command = new CapturingCommand();
    registry.register(command);
    const logger = { child: () => logger } as unknown as Logger;
    const dispatcher = new CommandDispatcher(
      registry,
      { evaluate: () => ({ allowed: true as const }) } as unknown as AccessPolicyService,
      logger,
    );

    await dispatcher.dispatch(interaction(null));

    expect(command.seen[0]!.text).toBe(texts.en);
  });

  it("shows a music failure through musicErrorText, choosing singular or plural", async () => {
    const { dispatcher, command } = setup(() => "en");
    command.failWith = new MusicRateLimitError(1);
    const first = interaction("guild-1");

    await dispatcher.dispatch(first);

    const embed = (first.reply.mock.calls[0]![0] as { embeds: { toJSON(): { title?: string; description?: string } }[] })
      .embeds[0]!.toJSON();
    expect(embed.title).toBe("Music command unavailable");
    expect(embed.description).toContain("Try again in 1 second.");
  });

  it("hides an unexpected error behind the generic failure message", async () => {
    const { dispatcher, command } = setup(() => "en");
    command.failWith = new Error("database exploded");
    const failing = interaction("guild-1");

    await dispatcher.dispatch(failing);

    const embed = (failing.reply.mock.calls[0]![0] as { embeds: { toJSON(): { title?: string; description?: string } }[] })
      .embeds[0]!.toJSON();
    expect(embed.title).toBe("Command error");
    expect(embed.description).toContain("The command could not be completed.");
    expect(embed.description).not.toContain("database exploded");
  });
});
