import { describe, expect, it } from "vitest";

import {
  CommandModule,
  type BotCommand,
} from "../../src/application/commands/command.js";
import {
  CommandRegistry,
  DuplicateCommandError,
  InvalidCommandError,
} from "../../src/application/commands/command-registry.js";
import {
  RoleMatchMode,
  publicAccessPolicy,
} from "../../src/domain/access/access-policy.js";

class TestCommand implements BotCommand {
  public readonly definition: BotCommand["definition"] = {
    name: "test",
    description: "A test command.",
  };

  public readonly module: CommandModule = CommandModule.Common;
  public readonly access = publicAccessPolicy;

  public execute(): Promise<void> {
    return Promise.resolve();
  }
}

class MusicTestCommand extends TestCommand {
  public override readonly definition: BotCommand["definition"] = {
    name: "music-test",
    description: "A music test command.",
  };

  public override readonly module = CommandModule.Music;
}

describe("CommandRegistry", () => {
  it("registers and resolves a valid command", () => {
    const registry = new CommandRegistry();
    const command = new TestCommand();

    registry.register(command);

    expect(registry.find("test")).toBe(command);
    expect(registry.getAll()).toEqual([command]);
  });

  it("rejects duplicate command names", () => {
    const registry = new CommandRegistry();
    registry.register(new TestCommand());

    expect(() => registry.register(new TestCommand())).toThrow(DuplicateCommandError);
  });

  it("rejects role matching without a configured role group", () => {
    const registry = new CommandRegistry();
    const command = new TestCommand();
    const invalidCommand: BotCommand = {
      ...command,
      access: {
        ...publicAccessPolicy,
        roles: {
          match: RoleMatchMode.Any,
          requiredGroups: [],
        },
      },
      execute: command.execute.bind(command),
    };

    expect(() => registry.register(invalidCommand)).toThrow(InvalidCommandError);
  });

  it("returns commands from enabled modules", () => {
    const registry = new CommandRegistry();
    registry.register(new TestCommand());
    registry.register(new MusicTestCommand());

    const commands = registry.getByEnabledModules(
      new Set([CommandModule.Common]),
    );

    expect(commands.map((command) => command.definition.name)).toEqual(["test"]);
  });
});
