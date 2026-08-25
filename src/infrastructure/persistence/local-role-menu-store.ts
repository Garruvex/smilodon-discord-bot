import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import type { RoleMenu, RoleMenuStore } from "../../application/roles/role-menu-store.js";

const roleMenuSchema = z.object({
  guildId: z.string(),
  channelId: z.string(),
  messageId: z.string(),
  options: z.array(z.object({ roleId: z.string(), label: z.string() })),
});

const documentSchema = z.object({
  version: z.literal(1),
  menus: z.array(roleMenuSchema),
});
type Document = z.infer<typeof documentSchema>;

export class LocalRoleMenuStore implements RoleMenuStore {
  private readonly file: string;

  public constructor(runtimeDataDirectory: string) {
    this.file = resolve(runtimeDataDirectory, "role-menus", "role-menus.json");
    mkdirSync(dirname(this.file), { recursive: true });
  }

  public initialize(): Promise<void> {
    return Promise.resolve();
  }

  public create(menu: RoleMenu): Promise<void> {
    const document = this.read();
    document.menus.push({ ...menu, options: [...menu.options] });
    this.write(document);
    return Promise.resolve();
  }

  public find(messageId: string): Promise<RoleMenu | null> {
    const menu = this.read().menus.find((m) => m.messageId === messageId);
    return Promise.resolve(menu ?? null);
  }

  public listForGuild(guildId: string): Promise<readonly RoleMenu[]> {
    return Promise.resolve(this.read().menus.filter((m) => m.guildId === guildId));
  }

  public remove(messageId: string): Promise<boolean> {
    const document = this.read();
    const index = document.menus.findIndex((m) => m.messageId === messageId);
    if (index === -1) return Promise.resolve(false);
    document.menus.splice(index, 1);
    this.write(document);
    return Promise.resolve(true);
  }

  private read(): Document {
    if (!existsSync(this.file)) return { version: 1, menus: [] };
    try {
      return documentSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch (error) {
      throw new Error(`Unable to read role menus "${this.file}".`, { cause: error });
    }
  }

  private write(document: Document): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporaryFile = `${this.file}.tmp`;
    writeFileSync(temporaryFile, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    renameSync(temporaryFile, this.file);
  }
}
