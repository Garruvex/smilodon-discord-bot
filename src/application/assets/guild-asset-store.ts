import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import type { Attachment } from "discord.js";

export class GuildAssetError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GuildAssetError";
  }
}

const allowedTypes = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);

export class GuildAssetStore {
  public constructor(private readonly runtimeDirectory: string) {}

  public async saveIdleImage(guildId: string, attachment: Attachment): Promise<string> {
    const extension = attachment.contentType ? allowedTypes.get(attachment.contentType) : undefined;
    if (!extension) throw new Error("Idle image must be a PNG, JPEG, WebP, or GIF file.");
    if (attachment.size > 8 * 1024 * 1024) throw new Error("Idle image must be 8 MB or smaller.");

    const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Discord image download failed with HTTP ${response.status}.`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > 8 * 1024 * 1024) throw new Error("Downloaded idle image exceeded 8 MB.");

    const relativeDirectory = `guild-assets/${guildId}`;
    const directory = resolve(this.runtimeDirectory, relativeDirectory);
    await mkdir(directory, { recursive: true });
    const target = resolve(directory, `idle${extension}`);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, data);
    await rename(temporary, target);

    for (const oldExtension of [".png", ".jpg", ".webp", ".gif"]) {
      if (oldExtension !== extension) await rm(resolve(directory, `idle${oldExtension}`), { force: true });
    }
    return `${relativeDirectory}/idle${extension}`;
  }

  public async removeIdleImage(asset: string | null): Promise<void> {
    if (!asset || !extname(asset)) return;
    const target = resolve(this.runtimeDirectory, asset);
    const root = resolve(this.runtimeDirectory, "guild-assets");
    if (!target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) return;
    await rm(target, { force: true });
  }

  public async savePersonality(guildId: string, attachment: Attachment): Promise<string> {
    // Discord may report Markdown attachments as application/octet-stream.
    // The extension, bounded download size, and decoded non-empty text are the
    // dependable validation signals here.
    if (!attachment.name.toLowerCase().endsWith(".md")) {
      throw new GuildAssetError("Chatbot personality must be uploaded as a Markdown (.md) file.");
    }
    if (attachment.size > 64 * 1024) throw new GuildAssetError("Chatbot personality must be 64 KB or smaller.");

    const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new GuildAssetError(`Discord personality download failed with HTTP ${response.status}.`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > 64 * 1024) throw new GuildAssetError("Downloaded personality exceeded 64 KB.");
    const content = data.toString("utf8").trim();
    if (!content) throw new GuildAssetError("Chatbot personality cannot be empty.");

    const relativeDirectory = `guild-assets/${guildId}`;
    const directory = resolve(this.runtimeDirectory, relativeDirectory);
    await mkdir(directory, { recursive: true });
    const target = resolve(directory, "personality.md");
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${content}\n`, "utf8");
    await rename(temporary, target);
    return `${relativeDirectory}/personality.md`;
  }

  public async removePersonality(asset: string | null): Promise<void> {
    if (!asset) return;
    const target = resolve(this.runtimeDirectory, asset);
    const root = resolve(this.runtimeDirectory, "guild-assets");
    if (!target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) return;
    await rm(target, { force: true });
  }
}
