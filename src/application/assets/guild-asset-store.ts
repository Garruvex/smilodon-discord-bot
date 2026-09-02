import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import type { Attachment } from "discord.js";
import type { Logger } from "pino";

import { buildExampleExchangeBundle, serializeExampleExchangeBundle } from "../chat/example-exchange-bundle.js";
import { parseExampleExchanges } from "../chat/example-exchange.js";
import type { PersonaBundleCompiler } from "../chat/persona-bundle-compiler.js";
import { parsePersonaBundle, serializePersonaBundle } from "../chat/persona-bundle.js";
import type { EmbeddingsClient } from "../chat/embeddings-client.js";

// The uploaded-personality.md size cap — also reused by FilePersonaSource as
// the char-truncation limit for the content it sends, so that limit can
// never truncate an actual upload (bytes >= chars for UTF-8 text) and only
// ever bounds a pathologically large admin-configured `personalityFile`
// that bypasses this upload check entirely.
export const personalityUploadMaxBytes = 64 * 1024;

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
  public constructor(
    private readonly runtimeDirectory: string,
    // Optional — when absent, personality uploads simply never get a
    // compiled bundle and always fall back to sending the full file (see
    // FilePersonaSource). Kept optional so tests and deployments without an
    // embeddings-capable provider configured don't need a stub.
    private readonly personaBundleCompiler: PersonaBundleCompiler | null = null,
    // Optional — when absent, examples uploads never get embeddings and
    // RelevantExampleExchangeSelector stays lexical-only (its long-standing
    // default; see example-exchange-selector.ts).
    private readonly embeddingsClient: EmbeddingsClient | null = null,
    private readonly logger: Logger | null = null,
  ) {}

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

  public async saveSelfReferenceImage(guildId: string, attachment: Attachment): Promise<string> {
    const extension = attachment.contentType ? allowedTypes.get(attachment.contentType) : undefined;
    if (!extension) throw new Error("Self-reference image must be a PNG, JPEG, WebP, or GIF file.");
    if (attachment.size > 8 * 1024 * 1024) throw new Error("Self-reference image must be 8 MB or smaller.");

    const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Discord image download failed with HTTP ${response.status}.`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > 8 * 1024 * 1024) throw new Error("Downloaded self-reference image exceeded 8 MB.");

    const relativeDirectory = `guild-assets/${guildId}`;
    const directory = resolve(this.runtimeDirectory, relativeDirectory);
    await mkdir(directory, { recursive: true });
    const target = resolve(directory, `self-reference${extension}`);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, data);
    await rename(temporary, target);

    for (const oldExtension of [".png", ".jpg", ".webp", ".gif"]) {
      if (oldExtension !== extension) await rm(resolve(directory, `self-reference${oldExtension}`), { force: true });
    }
    return `${relativeDirectory}/self-reference${extension}`;
  }

  public async removeSelfReferenceImage(asset: string | null): Promise<void> {
    if (!asset || !extname(asset)) return;
    const target = resolve(this.runtimeDirectory, asset);
    const root = resolve(this.runtimeDirectory, "guild-assets");
    if (!target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) return;
    await rm(target, { force: true });
  }

  // Generic byte-reader for assets a tool needs to load at call time (e.g. the
  // self-reference image, read fresh on every generate_self_image call rather
  // than cached, since it can be replaced between calls). Content type is
  // inferred from the stored extension, not re-detected from magic bytes —
  // these are our own files, written by saveSelfReferenceImage above, which
  // already validated the content type at upload time.
  public async readAsset(assetPath: string): Promise<{ data: Buffer; contentType: string } | null> {
    const target = resolve(this.runtimeDirectory, assetPath);
    const root = resolve(this.runtimeDirectory, "guild-assets");
    if (!target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) return null;
    const extension = extname(assetPath).toLowerCase();
    const contentType = [...allowedTypes.entries()].find(([, ext]) => ext === extension)?.[0];
    if (!contentType) return null;
    try {
      return { data: await readFile(target), contentType };
    } catch {
      return null;
    }
  }

  public async savePersonality(
    guildId: string,
    attachment: Attachment,
  ): Promise<{ assetPath: string; loreHeadings: readonly string[] }> {
    // Discord may report Markdown attachments as application/octet-stream.
    // The extension, bounded download size, and decoded non-empty text are the
    // dependable validation signals here.
    if (!attachment.name.toLowerCase().endsWith(".md")) {
      throw new GuildAssetError("Chatbot personality must be uploaded as a Markdown (.md) file.");
    }
    if (attachment.size > personalityUploadMaxBytes) throw new GuildAssetError("Chatbot personality must be 64 KB or smaller.");

    const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new GuildAssetError(`Discord personality download failed with HTTP ${response.status}.`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > personalityUploadMaxBytes) throw new GuildAssetError("Downloaded personality exceeded 64 KB.");
    const content = data.toString("utf8").trim();
    if (!content) throw new GuildAssetError("Chatbot personality cannot be empty.");

    const relativeDirectory = `guild-assets/${guildId}`;
    const directory = resolve(this.runtimeDirectory, relativeDirectory);
    await mkdir(directory, { recursive: true });
    const target = resolve(directory, "personality.md");
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${content}\n`, "utf8");
    await rename(temporary, target);
    const loreHeadings = await this.compilePersonalityBundle(directory, guildId, content);
    return { assetPath: `${relativeDirectory}/personality.md`, loreHeadings };
  }

  // Best-effort — a compilation failure must never fail the upload itself,
  // it just means this guild keeps sending the full personality file until
  // the next successful upload (see PersonaBundleCompiler, FilePersonaSource).
  // Returns the headings the classifier moved out of the always-sent core
  // into situational lore, so the admin who just uploaded this file can see
  // which sections are no longer sent on every turn (see chatbot-setting.ts) —
  // otherwise a misclassified identity section only silently shows up some
  // turns, with nothing surfacing the split at upload time.
  private async compilePersonalityBundle(directory: string, guildId: string, content: string): Promise<readonly string[]> {
    if (!this.personaBundleCompiler) return [];
    try {
      const previousBundle = parsePersonaBundle(
        await readFile(resolve(directory, "personality.bundle.json"), "utf8").catch(() => "null"),
      );
      const bundle = await this.personaBundleCompiler.compile(content, previousBundle);
      if (!bundle) return [];
      const target = resolve(directory, "personality.bundle.json");
      const temporary = `${target}.tmp`;
      await writeFile(temporary, serializePersonaBundle(bundle), "utf8");
      await rename(temporary, target);
      return bundle.chunks.map((chunk) => chunk.heading);
    } catch (error) {
      this.logger?.warn({ error, guildId }, "Writing the compiled personality bundle failed; the full file will be sent as-is");
      return [];
    }
  }

  public async removePersonality(asset: string | null): Promise<void> {
    if (!asset) return;
    const target = resolve(this.runtimeDirectory, asset);
    const root = resolve(this.runtimeDirectory, "guild-assets");
    if (!target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) return;
    await rm(target, { force: true });
    await rm(`${target.slice(0, -".md".length)}.bundle.json`, { force: true });
  }

  public async saveExamples(guildId: string, attachment: Attachment): Promise<string> {
    if (!attachment.name.toLowerCase().endsWith(".md")) {
      throw new GuildAssetError("Chatbot examples must be uploaded as a Markdown (.md) file.");
    }
    if (attachment.size > 128 * 1024) throw new GuildAssetError("Chatbot examples must be 128 KB or smaller.");

    const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new GuildAssetError(`Discord examples download failed with HTTP ${response.status}.`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > 128 * 1024) throw new GuildAssetError("Downloaded examples file exceeded 128 KB.");
    const content = data.toString("utf8").trim();
    if (!content) throw new GuildAssetError("Chatbot examples cannot be empty.");

    const parsed = parseExampleExchanges(content);
    if ("error" in parsed) throw new GuildAssetError(parsed.error);

    const relativeDirectory = `guild-assets/${guildId}`;
    const directory = resolve(this.runtimeDirectory, relativeDirectory);
    await mkdir(directory, { recursive: true });
    const target = resolve(directory, "examples.md");
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${content}\n`, "utf8");
    await rename(temporary, target);
    await this.embedExamplesBundle(directory, guildId, content, parsed.exchanges);
    return `${relativeDirectory}/examples.md`;
  }

  // Best-effort — an embedding failure must never fail the upload itself, it
  // just means this guild's example selection stays lexical-only until the
  // next successful upload (see RelevantExampleExchangeSelector, FilePersonaSource).
  private async embedExamplesBundle(
    directory: string, guildId: string, content: string, exchanges: readonly { tags: string; user: string; character: string }[],
  ): Promise<void> {
    if (!this.embeddingsClient) return;
    try {
      const bundle = await buildExampleExchangeBundle(content, exchanges, this.embeddingsClient);
      const target = resolve(directory, "examples.bundle.json");
      const temporary = `${target}.tmp`;
      await writeFile(temporary, serializeExampleExchangeBundle(bundle), "utf8");
      await rename(temporary, target);
    } catch (error) {
      this.logger?.warn({ error, guildId }, "Embedding the examples bundle failed; example selection will stay lexical-only");
    }
  }

  public async removeExamples(asset: string | null): Promise<void> {
    if (!asset) return;
    const target = resolve(this.runtimeDirectory, asset);
    const root = resolve(this.runtimeDirectory, "guild-assets");
    if (!target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) return;
    await rm(target, { force: true });
    await rm(`${target.slice(0, -".md".length)}.bundle.json`, { force: true });
  }
}
