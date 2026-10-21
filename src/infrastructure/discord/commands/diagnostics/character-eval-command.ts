import type { MessageContextMenuCommandInteraction } from "discord.js";
import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { CharacterEvaluationStore} from "../../../../application/chat/character-evaluation.js";
import { believabilityCategories, interviewProbes } from "../../../../application/chat/character-evaluation.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import { characterSettings } from "../../../../application/chat/character-settings.js";
import type { MessageOriginStore } from "../../../../application/chat/message-origin-store.js";
import type { CharacterRuntime } from "../../../../application/chat/character-runtime.js";
import type { GuardedEvaluationContext } from "../../../../application/context/guarded-evaluation-context.js";
import { settingsAccessPolicy } from "../../settings/engine/settings-engine.js";

export class CharacterEvalCommand implements BotCommand {
  public readonly module = CommandModule.Diagnostics;
  public readonly access = settingsAccessPolicy;
  public readonly responseVisibility = CommandResponseVisibility.Ephemeral;
  public readonly definition = { name: "character-eval", description: "Review character consistency and conversation failures.", subcommands: [
    { name: "flag", description: "Tag a bot chat message for review.", options: [
      { type: "string", name: "message", description: "Message ID in this channel.", required: true },
      { type: "string", name: "category", description: "What broke believability.", required: true, choices: believabilityCategories.map((value) => ({ name: value, value })) },
    ] },
    { name: "probes", description: "Run interview probes without posting replies or changing character memory." },
    { name: "pair", description: "Generate a blind baseline/candidate pair for a synthetic probe.", options: [{ type: "string", name: "question", description: "Interview question.", required: true, maxLength: 500 }] },
    { name: "label", description: "Record a human preference for a blind pair.", options: [
      { type: "string", name: "pair", description: "Pair ID.", required: true }, { type: "string", name: "preference", description: "Which felt more like the character.", required: true, choices: ["A", "B", "tie", "neither"].map((value) => ({ name: value, value })) },
    ] },
    { name: "export", description: "Export review metadata and synthetic probe results." },
  ] } satisfies BotCommand["definition"];
  public constructor(private readonly profiles: GuildConfigurationProvider, private readonly origins: MessageOriginStore,
    private readonly store: CharacterEvaluationStore, private readonly runtime: CharacterRuntime,
    private readonly requestFor: (guildId: string, channelId: string, userId: string, question: string) => Promise<GuardedEvaluationContext>) {}
  public async execute(context: CommandContext): Promise<void> {
    const interaction = context.interaction; if (!interaction.guildId || !interaction.channelId) return;
    const profile = this.profiles.find(interaction.guildId);
    if (!profile || !characterSettings(profile).modules.evaluation.enabled) { await context.responses.reply("Enable character evaluation in settings first."); return; }
    await context.responses.defer();
    const action = interaction.options.getSubcommand();
    if (action === "flag") {
      const messageId = interaction.options.getString("message", true);
      const origin = await this.origins.find(interaction.guildId, interaction.channelId, messageId);
      if (origin?.origin !== "chat") { await context.responses.edit("That is not a recorded bot chat message in this channel."); return; }
      const id = await this.store.record(interaction.guildId, "flag", { messageId, channelId: interaction.channelId,
        category: interaction.options.getString("category", true), reviewerId: interaction.user.id });
      await context.responses.edit(`Flag saved: ${id}`); return;
    }
    if (action === "label") {
      const pairId = interaction.options.getString("pair", true);
      if (!(await this.store.list(interaction.guildId)).some((record) => record.id === pairId && record.kind === "pair")) { await context.responses.edit("Pair not found."); return; }
      await this.store.record(interaction.guildId, "label", { pairId, reviewerId: interaction.user.id, preference: interaction.options.getString("preference", true) });
      await context.responses.edit("Human preference saved."); return;
    }
    if (action === "export") {
      await context.responses.edit({ content: "Character review records (30-day retention).", files: [{ attachment: Buffer.from(JSON.stringify(await this.store.list(interaction.guildId), null, 2)), name: "character-evaluation.json" }] }); return;
    }
    if (action === "pair") {
      const question = interaction.options.getString("question", true);
      const request = await this.requestFor(interaction.guildId, interaction.channelId, interaction.user.id, question);
      const pair = await this.runtime.probePair(request);
      const id = await this.store.record(interaction.guildId, "pair", { question, ...pair, reviewerId: interaction.user.id });
      await context.responses.edit(`Pair ${id}\nA: ${pair.A}\nB: ${pair.B}\nUse /character-eval label to record your preference.`); return;
    }
    const requests: GuardedEvaluationContext[] = [];
    for (const question of interviewProbes) {
      const request = await this.requestFor(interaction.guildId, interaction.channelId, interaction.user.id, question);
      requests.push(request);
    }
    const outputs = await this.runtime.probeMany(requests);
    await this.store.record(interaction.guildId, "probe", { reviewerId: interaction.user.id, outputs });
    await context.responses.edit({ content: "Interview probes generated for human review. No character memory was changed.", files: [{ attachment: Buffer.from(JSON.stringify(outputs, null, 2)), name: "character-interview.json" }] });
  }
}
export class FeltLikeBotCommand implements BotCommand<MessageContextMenuCommandInteraction> {
  public readonly definition = { type: "messageContextMenu", name: "Felt like a bot" } satisfies BotCommand<MessageContextMenuCommandInteraction>["definition"];
  public readonly module = CommandModule.Diagnostics;
  public readonly access = settingsAccessPolicy;
  public readonly responseVisibility = CommandResponseVisibility.Ephemeral;
  public constructor(private readonly profiles: GuildConfigurationProvider, private readonly origins: MessageOriginStore, private readonly store: CharacterEvaluationStore) {}
  public async execute(context: CommandContext<MessageContextMenuCommandInteraction>): Promise<void> {
    const interaction = context.interaction;
    const profile = interaction.guildId ? this.profiles.find(interaction.guildId) : null;
    if (!profile || !characterSettings(profile).modules.evaluation.enabled) { await context.responses.reply("Enable character evaluation first."); return; }
    const message = interaction.targetMessage; const origin = await this.origins.find(profile.guildId, message.channelId, message.id);
    if (origin?.origin !== "chat") { await context.responses.reply("Only recorded bot chat messages can be flagged."); return; }
    const id = await this.store.record(profile.guildId, "flag", { channelId: message.channelId, messageId: message.id, category: "other", reviewerId: interaction.user.id });
    await context.responses.reply(`Flag saved: ${id}. Use /character-eval flag for a specific category.`);
  }
}
