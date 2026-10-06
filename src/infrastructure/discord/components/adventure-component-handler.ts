import { revisionOf } from "../../../application/campaign/adventures/stored-adventure.js";
import { defaultMaxAdventuresPerGuild, type AdventureCatalog } from "../../../application/campaign/adventures/adventure-catalog.js";
import { CommandModule } from "../../../application/commands/command.js";
import type { ComponentContext, ComponentHandler } from "../../../application/components/component-handler.js";
import { texts } from "../../../application/i18n/texts.js";
import { publicAccessPolicy } from "../../../domain/access/access-policy.js";
import type { CampaignAuthority } from "../campaign/campaign-authority.js";
import { adventureIdPrefix, parseAdventureId, renderRemoveAsk, renderReview } from "../campaign/adventure-preview.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import { languageOf } from "./character-library-component-handler.js";

export interface AdventureHandlerDependencies {
  readonly catalog: AdventureCatalog;
  readonly authority: CampaignAuthority;
  readonly glossaries?: Readonly<Record<string, Glossary>>;
  // A complete adventure file to start from, in the asker's language; without it the example button says there is none.
  readonly example?: (language: "en" | "zh-TW") => string;
}

// Approve or Discard on an adventure draft, and Review, Remove and Restore from the server's adventure list. Anyone can press the button; the
// catalog decides who may: the person who brought it, or a DnD Admin.
export class AdventureComponentHandler implements ComponentHandler {
  public readonly customIdPrefix = adventureIdPrefix;
  public readonly module = CommandModule.Campaign;
  public readonly access = publicAccessPolicy;

  public constructor(private readonly deps: AdventureHandlerDependencies) {}

  public async execute(context: ComponentContext): Promise<void> {
    const { interaction } = context;
    const parsed = parseAdventureId(interaction.customId);
    if (parsed === null || !interaction.isButton() || !interaction.inCachedGuild()) return;
    const t = texts[languageOf(interaction)].campaign.adventure;
    await interaction.deferUpdate();
    const isAdmin = await this.deps.authority.isAdmin(interaction);
    if (parsed.action === "example") {
      const language = languageOf(interaction);
      const file = this.deps.example?.(language);
      return void (await interaction.followUp({ content: file === undefined ? t.gone : t.exampleSent, ...(file === undefined ? {} : { files: [{ attachment: Buffer.from(file, "utf8"), name: `example-adventure-${language}.yaml` }] }), ephemeral: true }));
    }
    // A draft is only ever decided in the server it was made in.
    const draft = await this.deps.catalog.get(parsed.key);
    if (draft === undefined || draft.guildId !== interaction.guildId) return void (await interaction.editReply({ content: t.gone, components: [] }));
    const language = languageOf(interaction);
    const screen = { edit: (payload: { content: string; components?: never[] }): Promise<unknown> => interaction.editReply(payload) };
    if (parsed.action === "review") {
      const reviewed = await this.deps.catalog.review(parsed.key);
      if (reviewed === undefined || reviewed.adventure.status !== "pending") return void (await screen.edit({ content: t.notPending, components: [] }));
      return void (await interaction.editReply(renderReview({ report: reviewed.report, adventure: reviewed.adventure, text: texts[language], glossary: this.deps.glossaries?.[reviewed.adventure.language] })));
    }
    if (parsed.action === "remove" || parsed.action === "confirmremove" || parsed.action === "keep" || parsed.action === "restore") {
      if (draft.uploaderUserId !== interaction.user.id && !isAdmin) return void (await interaction.followUp({ content: t.notAllowed, ephemeral: true }));
      if (parsed.revision !== revisionOf(draft)) return void (await screen.edit({ content: t.stale, components: [] }));
      if (parsed.action === "keep") return void (await screen.edit({ content: t.kept, components: [] }));
      if (parsed.action === "remove") {
        if (draft.status !== "approved") return void (await screen.edit({ content: t.wrongStatus, components: [] }));
        return void (await interaction.editReply(renderRemoveAsk({ adventure: draft, usage: await this.deps.catalog.usage(draft), text: texts[language] })));
      }
      const changed = parsed.action === "confirmremove" ? await this.deps.catalog.remove(parsed.key, interaction.user.id, isAdmin) : await this.deps.catalog.restore(parsed.key, interaction.user.id, isAdmin);
      switch (changed.kind) {
        case "ok":
          return void (await screen.edit({ content: parsed.action === "restore" ? t.restored({ title: changed.adventure.title }) : t.removed({ title: changed.adventure.title }), components: [] }));
        case "full":
          return void (await screen.edit({ content: t.restoreFull({ max: defaultMaxAdventuresPerGuild }), components: [] }));
        case "notAllowed":
          return void (await interaction.followUp({ content: t.notAllowed, ephemeral: true }));
        case "wrongStatus":
          return void (await screen.edit({ content: t.wrongStatus, components: [] }));
        case "notFound":
          return void (await screen.edit({ content: t.gone, components: [] }));
      }
    }
    const result = parsed.action === "approve" ? await this.deps.catalog.approve(parsed.key, interaction.user.id, isAdmin, parsed.revision) : await this.deps.catalog.discard(parsed.key, interaction.user.id, isAdmin, parsed.revision);
    switch (result.kind) {
      case "ok":
        return void (await interaction.editReply({ content: parsed.action === "approve" ? t.approved({ title: result.adventure.title }) : t.discarded, components: [] }));
      case "notAllowed":
        return void (await interaction.followUp({ content: t.notAllowed, ephemeral: true }));
      case "stale":
        return void (await interaction.editReply({ content: t.stale, components: [] }));
      case "notPending":
        return void (await interaction.editReply({ content: t.notPending, components: [] }));
      case "notFound":
        return void (await interaction.editReply({ content: t.gone, components: [] }));
    }
  }
}
