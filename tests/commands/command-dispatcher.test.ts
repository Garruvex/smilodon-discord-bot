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
