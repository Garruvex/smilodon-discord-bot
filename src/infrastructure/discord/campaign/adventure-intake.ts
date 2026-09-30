import type { ActionRowBuilder, ChatInputCommandInteraction } from "discord.js";

import { defaultMaxAdventuresPerGuild, type AdventureCatalog, type SubmitResult } from "../../../application/campaign/adventures/adventure-catalog.js";
import { maxIdeaChars, maxNotesChars, type AdventureAuthor } from "../../../application/campaign/adventures/adventure-author.js";
import { adventureLimits } from "../../../application/campaign/adventures/adventure-validator.js";
import { parseAdventureDocument } from "../../../application/campaign/adventures/adventure-document.js";
import { texts, type Texts } from "../../../application/i18n/texts.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import { languageOf } from "../components/character-library-component-handler.js";
import { downloadAttachmentText } from "./attachment-download.js";
import { renderLibrary, renderReview } from "./adventure-preview.js";

export interface AdventureIntakeOptions {
  readonly catalog: AdventureCatalog;
  // Null when no AI model is configured: uploading still works.
  readonly author: AdventureAuthor | null;
  readonly glossaries: Readonly<Record<string, Glossary>>;
}

// /dnd upload-adventure and /dnd author, and the hub's Upload adventure and
// Write an adventure forms (plan §3, Campaign source): all end in the same
// private review, and nothing plays until it is approved.

// Where an intake reports: who asked, for which server, in which language, and
// how to answer them privately (a slash command's reply or a form's).
export interface IntakeContext {
  readonly guildId: string;
  readonly userId: string;
  readonly language: "en" | "zh-TW";
  // Both ways in (the command and the hub's forms) are for DnD Admins only, and check it before this point.
  readonly isAdmin: boolean;
  readonly editReply: (payload: { readonly content: string; readonly components?: readonly ActionRowBuilder<never>[] }) => Promise<unknown>;
}

export interface UploadedFile {
  readonly url: string;
  readonly size: number;
}

export function slashContext(interaction: ChatInputCommandInteraction<"cached">): IntakeContext {
  return {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    language: languageOf(interaction),
    isAdmin: true,
    editReply: (payload) => interaction.editReply(payload),
  };
}

export class AdventureIntake {
  public constructor(private readonly options: AdventureIntakeOptions) {}

  public get canAuthor(): boolean {
    return this.options.author !== null;
  }

  public upload(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
    const file = interaction.options.getAttachment("file");
    return this.uploadFile(slashContext(interaction), file === null ? null : { url: file.url, size: file.size }, interaction.options.getString("language") === "zh-TW" ? "zh-TW" : "en");
  }

  public adventures(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
    return this.browse(slashContext(interaction));
  }

  public author(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
    const attachment = interaction.options.getAttachment("notes");
    return this.authorFrom(slashContext(interaction), {
      idea: interaction.options.getString("idea") ?? "",
      gameLanguage: interaction.options.getString("language") === "zh-TW" ? "zh-TW" : "en",
      notes: attachment === null ? null : { url: attachment.url, size: attachment.size },
    });
  }

  // /dnd adventures: what the server holds, with a way to reopen a review, remove or restore.
  public async browse(ctx: IntakeContext): Promise<void> {
    const adventures = await this.options.catalog.list(ctx.guildId);
    await ctx.editReply(renderLibrary({ adventures, text: texts[ctx.language] }) as never);
  }

  public async uploadFile(ctx: IntakeContext, file: UploadedFile | null, gameLanguage: "en" | "zh-TW"): Promise<void> {
    const text = texts[ctx.language];
    const reply = (content: string): Promise<void> => ctx.editReply({ content }).then(() => undefined);
    if (file === null) return reply(text.campaign.adventure.uploadNeedsFile);
    if (file.size > adventureLimits.maxBytes) return reply(text.campaign.adventure.unreadable.tooLarge);
    const downloaded = await downloadAttachmentText(file.url, adventureLimits.maxBytes);
    if (!downloaded.ok) return reply(text.campaign.adventure.unreadable[downloaded.reason]);
    try {
      const declaredLanguage = parseAdventureDocument(downloaded.text).bible.language;
      if (declaredLanguage !== gameLanguage) return reply(text.campaign.adventure.uploadLanguageMismatch({ selected: text.campaign.language[gameLanguage === "en" ? "en" : "zhTW"], declared: text.campaign.language[declaredLanguage === "en" ? "en" : "zhTW"] }));
    } catch {
      // The catalog produces the full validation report for malformed files.
    }
    const result = await this.options.catalog.submit({ guildId: ctx.guildId, uploaderUserId: ctx.userId, source: "upload", text: downloaded.text, isAdmin: ctx.isAdmin });
    await this.review(ctx, result, text);
  }

  public async authorFrom(ctx: IntakeContext, input: { readonly idea: string; readonly gameLanguage: "en" | "zh-TW"; readonly notes: UploadedFile | null }): Promise<void> {
    const text = texts[ctx.language];
    const t = text.campaign.adventure;
    const reply = (content: string): Promise<void> => ctx.editReply({ content }).then(() => undefined);
    if (this.options.author === null) return reply(t.authorNoModel);
    let notes = "";
    if (input.notes !== null) {
      // Notes are text or Markdown, read as data.
      const downloaded = await downloadAttachmentText(input.notes.url, maxNotesChars * 4);
      if (!downloaded.ok) return reply(t.unreadable[downloaded.reason]);
      notes = downloaded.text;
    }
    if ([...input.idea].length > maxIdeaChars || [...notes].length > maxNotesChars) return reply(t.authorTooLong({ idea: maxIdeaChars, notes: maxNotesChars }));
    await ctx.editReply({ content: t.authorWorking });
    let written;
    try {
      written = await this.options.author.write({ language: input.gameLanguage, idea: input.idea, notes });
    } catch {
      return reply(t.authorFailedModel);
    }
    if (written.kind === "tooLong") return reply(t.authorTooLong({ idea: maxIdeaChars, notes: maxNotesChars }));
    if (written.kind === "failed") return reply([t.authorFailed, ...written.problems.slice(0, 10).map((problem) => `• ${problem}`)].join("\n"));
    const result = await this.options.catalog.submit({ guildId: ctx.guildId, uploaderUserId: ctx.userId, source: "author", text: written.yaml, isAdmin: ctx.isAdmin });
    await this.review(ctx, result, text);
  }

  private async review(ctx: IntakeContext, result: SubmitResult, text: Texts): Promise<void> {
    const t = text.campaign.adventure;
    switch (result.kind) {
      case "exists":
        return void (await ctx.editReply({ content: t.exists }));
      case "notAllowed":
        return void (await ctx.editReply({ content: t.replaceNotAllowed }));
      case "full":
        return void (await ctx.editReply({ content: t.full({ max: defaultMaxAdventuresPerGuild }) }));
      case "invalid":
        return void (await ctx.editReply(renderReview({ report: result.report, adventure: null, text, glossary: this.options.glossaries[ctx.language] }) as never));
      case "pending":
        return void (await ctx.editReply(renderReview({ report: result.report, adventure: result.adventure, replaced: result.replaced !== null, text, glossary: this.options.glossaries[result.adventure.language] }) as never));
    }
  }
}
