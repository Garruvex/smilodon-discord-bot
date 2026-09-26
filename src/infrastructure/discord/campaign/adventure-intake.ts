import type { ChatInputCommandInteraction } from "discord.js";

import { defaultMaxAdventuresPerGuild, type AdventureCatalog, type SubmitResult } from "../../../application/campaign/adventures/adventure-catalog.js";
import { maxIdeaChars, maxNotesChars, type AdventureAuthor } from "../../../application/campaign/adventures/adventure-author.js";
import { adventureLimits } from "../../../application/campaign/adventures/adventure-validator.js";
import { texts, type Texts } from "../../../application/i18n/texts.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import { languageOf } from "../components/character-library-component-handler.js";
import { downloadAttachmentText } from "./attachment-download.js";
import { renderReview } from "./adventure-preview.js";

export interface AdventureIntakeOptions {
  readonly catalog: AdventureCatalog;
  // Null when no AI model is configured: uploading still works.
  readonly author: AdventureAuthor | null;
  readonly glossaries: Readonly<Record<string, Glossary>>;
}

// /dnd upload-adventure and /dnd author (plan §3, Campaign source): both end
// in the same private review, and nothing plays until it is approved.
export class AdventureIntake {
  public constructor(private readonly options: AdventureIntakeOptions) {}

  public async upload(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
    const language = languageOf(interaction);
    const text = texts[language];
    const file = interaction.options.getAttachment("file");
    if (file === null) return void (await interaction.editReply({ content: text.campaign.adventure.uploadNeedsFile }));
    if (file.size > adventureLimits.maxBytes) return void (await interaction.editReply({ content: text.campaign.adventure.unreadable.tooLarge }));
    const downloaded = await downloadAttachmentText(file.url, adventureLimits.maxBytes);
    if (!downloaded.ok) return void (await interaction.editReply({ content: text.campaign.adventure.unreadable[downloaded.reason] }));
    const result = await this.options.catalog.submit({ guildId: interaction.guildId, uploaderUserId: interaction.user.id, source: "upload", text: downloaded.text });
    await this.review(interaction, result, text, language);
  }

  public async author(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
    const language = languageOf(interaction);
    const text = texts[language];
    const t = text.campaign.adventure;
    if (this.options.author === null) return void (await interaction.editReply({ content: t.authorNoModel }));
    const idea = interaction.options.getString("idea") ?? "";
    const gameLanguage = interaction.options.getString("language") === "zh-TW" ? "zh-TW" : "en";
    let notes = "";
    const attachment = interaction.options.getAttachment("notes");
    if (attachment !== null) {
      // Notes are text or Markdown, read as data.
      const downloaded = await downloadAttachmentText(attachment.url, maxNotesChars * 4);
      if (!downloaded.ok) return void (await interaction.editReply({ content: t.unreadable[downloaded.reason] }));
      notes = downloaded.text;
    }
    if ([...idea].length > maxIdeaChars || [...notes].length > maxNotesChars) return void (await interaction.editReply({ content: t.authorTooLong({ idea: maxIdeaChars, notes: maxNotesChars }) }));
    await interaction.editReply({ content: t.authorWorking });
    let written;
    try {
      written = await this.options.author.write({ language: gameLanguage, idea, notes });
    } catch {
      return void (await interaction.editReply({ content: t.authorFailedModel }));
    }
    if (written.kind === "tooLong") return void (await interaction.editReply({ content: t.authorTooLong({ idea: maxIdeaChars, notes: maxNotesChars }) }));
    if (written.kind === "failed") return void (await interaction.editReply({ content: [t.authorFailed, ...written.problems.slice(0, 10).map((problem) => `• ${problem}`)].join("\n") }));
    const result = await this.options.catalog.submit({ guildId: interaction.guildId, uploaderUserId: interaction.user.id, source: "author", text: written.yaml });
    await this.review(interaction, result, text, language);
  }

  private async review(interaction: ChatInputCommandInteraction<"cached">, result: SubmitResult, text: Texts, language: "en" | "zh-TW"): Promise<void> {
    const t = text.campaign.adventure;
    switch (result.kind) {
      case "exists":
        return void (await interaction.editReply({ content: t.exists }));
      case "full":
        return void (await interaction.editReply({ content: t.full({ max: defaultMaxAdventuresPerGuild }) }));
      case "invalid":
        return void (await interaction.editReply(renderReview({ report: result.report, adventure: null, text, glossary: this.options.glossaries[language] })));
      case "pending":
        return void (await interaction.editReply(renderReview({ report: result.report, adventure: result.adventure, text, glossary: this.options.glossaries[result.adventure.language] })));
    }
  }
}
