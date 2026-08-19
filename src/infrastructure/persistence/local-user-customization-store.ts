import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { UserCustomizationStore } from "../../application/chat/user-customization-store.js";

export class LocalUserCustomizationStore implements UserCustomizationStore {
  private readonly chatRoot: string;

  public constructor(runtimeDataDirectory: string) {
    this.chatRoot = resolve(runtimeDataDirectory, "chat");
    mkdirSync(this.chatRoot, { recursive: true });
  }

  public initialize(): Promise<void> {
    return Promise.resolve();
  }

  public load(guildId: string, userId: string): Promise<string | null> {
    const file = this.userFile(guildId, userId);
    if (!existsSync(file)) return Promise.resolve(null);
    return Promise.resolve(readFileSync(file, "utf8"));
  }

  public save(guildId: string, userId: string, markdown: string): Promise<void> {
    const file = this.userFile(guildId, userId);
    mkdirSync(dirname(file), { recursive: true });
    const temporaryFile = `${file}.tmp`;
    writeFileSync(temporaryFile, markdown, "utf8");
    renameSync(temporaryFile, file);
    return Promise.resolve();
  }

  public clear(guildId: string, userId: string): Promise<void> {
    rmSync(this.userFile(guildId, userId), { force: true });
    return Promise.resolve();
  }

  private userFile(guildId: string, userId: string): string {
    return resolve(this.chatRoot, safeSegment(guildId), "users", `${safeSegment(userId)}.customization.md`);
  }
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error(`Unsafe chat-state identifier "${value}".`);
  return value;
}
