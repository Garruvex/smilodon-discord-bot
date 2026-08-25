import type { AnyCommandInteraction, BotCommand } from "./command.js";
import { RoleMatchMode } from "../../domain/access/access-policy.js";

export class DuplicateCommandError extends Error {
  public constructor(commandName: string) {
    super(`A command named "${commandName}" is already registered.`);
    this.name = "DuplicateCommandError";
  }
}

export class InvalidCommandError extends Error {
  public constructor(commandName: string, reason: string) {
    super(`Command "${commandName}" is invalid: ${reason}`);
    this.name = "InvalidCommandError";
  }
}

export class CommandRegistry {
  private readonly commands = new Map<string, BotCommand<AnyCommandInteraction>>();

  public register(command: BotCommand<AnyCommandInteraction>): void {
    const commandName = command.definition.name;

    if (this.commands.has(commandName)) {
      throw new DuplicateCommandError(commandName);
    }

    this.validate(command);
    this.commands.set(commandName, command);
  }

  public find(commandName: string): BotCommand<AnyCommandInteraction> | null {
    return this.commands.get(commandName) ?? null;
  }

  public getAll(): readonly BotCommand<AnyCommandInteraction>[] {
    return [...this.commands.values()];
  }

  private validate(command: BotCommand<AnyCommandInteraction>): void {
    const commandName = command.definition.name;
    const rolePolicy = command.access.roles;

    if (
      rolePolicy.match !== RoleMatchMode.None &&
      rolePolicy.requiredGroups.length === 0
    ) {
      throw new InvalidCommandError(
        commandName,
        `role match mode "${rolePolicy.match}" requires at least one role group`,
      );
    }

    if (
      rolePolicy.match === RoleMatchMode.None &&
      rolePolicy.requiredGroups.length > 0
    ) {
      throw new InvalidCommandError(
        commandName,
        "role groups cannot be required when role matching is disabled",
      );
    }
  }
}
