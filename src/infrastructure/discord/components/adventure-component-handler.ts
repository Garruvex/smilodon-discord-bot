import type { AdventureCatalog } from "../../../application/campaign/adventures/adventure-catalog.js";
import { CommandModule } from "../../../application/commands/command.js";
import type { ComponentContext, ComponentHandler } from "../../../application/components/component-handler.js";
import { texts } from "../../../application/i18n/texts.js";
import { publicAccessPolicy } from "../../../domain/access/access-policy.js";
import type { CampaignAuthority } from "../campaign/campaign-authority.js";
import { adventureIdPrefix, parseAdventureId } from "../campaign/adventure-preview.js";
import { languageOf } from "./character-library-component-handler.js";

export interface AdventureHandlerDependencies {
  readonly catalog: AdventureCatalog;
  readonly authority: CampaignAuthority;
}

// Approve or Discard on an adventure draft. Anyone can press the button; the
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
    // A draft is only ever decided in the server it was made in.
    const draft = await this.deps.catalog.get(parsed.key);
    if (draft === undefined || draft.guildId !== interaction.guildId) return void (await interaction.editReply({ content: t.gone, components: [] }));
    const result = parsed.action === "approve" ? await this.deps.catalog.approve(parsed.key, interaction.user.id, isAdmin) : await this.deps.catalog.discard(parsed.key, interaction.user.id, isAdmin);
    switch (result.kind) {
      case "ok":
        return void (await interaction.editReply({ content: parsed.action === "approve" ? t.approved({ title: result.adventure.title }) : t.discarded, components: [] }));
      case "notAllowed":
        return void (await interaction.followUp({ content: t.notAllowed, ephemeral: true }));
      case "notPending":
        return void (await interaction.editReply({ content: t.notPending, components: [] }));
      case "notFound":
        return void (await interaction.editReply({ content: t.gone, components: [] }));
    }
  }
}
