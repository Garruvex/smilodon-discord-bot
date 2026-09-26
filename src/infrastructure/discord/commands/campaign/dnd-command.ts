import { ChannelType, type ChatInputCommandInteraction } from "discord.js";

import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { CampaignLobbyService } from "../../../../application/campaign/campaign-lobby-service.js";
import type { CampaignPlayController, ManageAction, PlayResult } from "../../../../application/campaign/campaign-play-controller.js";
import type { StoredRecord } from "../../../../application/campaign/ports/campaign-record.js";
import type { Texts } from "../../../../application/i18n/texts.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import type { CampaignAuthority } from "../../campaign/campaign-authority.js";
import type { CampaignGameCreator } from "../../campaign/campaign-game-creator.js";
import { createGameText } from "../../campaign/campaign-game-creator.js";
import type { CampaignCardService } from "../../campaign/campaign-card-service.js";
import type { CampaignSetupService } from "../../campaign/campaign-setup-service.js";
import { refusalText } from "../../campaign/refusal-text.js";

export interface DndCommandDependencies {
  readonly lobby: CampaignLobbyService;
  readonly play: CampaignPlayController;
  readonly setup: CampaignSetupService;
  readonly cards: CampaignCardService;
  readonly creator: CampaignGameCreator;
  readonly authority: CampaignAuthority;
}

// Setting up a server is for bot administrators (plan §3, Server setup).
// Creating games is for them and the server's DnD Admin role. The rest of /dnd
// is for the organizer of the game whose channel it is run in, or a DnD Admin.

export class DndCommand implements BotCommand {
  public readonly definition = {
    name: "dnd",
    description: "Runs AI-hosted D&D campaigns.",
    subcommands: [
      {
        name: "setup",
        description: "Sets this server up for D&D games and makes this channel the hub.",
        options: [{ type: "channel", name: "hub", description: "The hub channel (default: this one).", guildTextOnly: true }],
      },
      {
        name: "new",
        description: "Creates a new game with its own channels.",
        options: [
          { type: "string", name: "name", description: "The game's name.", required: true, maxLength: 60 },
          {
            type: "string",
            name: "language",
            description: "The language the game is played in (default: English).",
            choices: [
              { name: "English", value: "en" },
              { name: "繁體中文", value: "zh-TW" },
            ],
          },
          {
            type: "string",
            name: "pacing",
            description: "How fast rounds go (default: live).",
            choices: [
              { name: "Live (minutes per round)", value: "live" },
              { name: "Play-by-post (a day per round)", value: "playByPost" },
            ],
          },
          { type: "integer", name: "players", description: "Most players at the table (default: 3).", minValue: 1, maxValue: 6 },
        ],
      },
      { name: "status", description: "Shows the state of this channel's game." },
      { name: "pause", description: "Pauses this game (organizer)." },
      { name: "resume", description: "Resumes a paused game (organizer)." },
      { name: "close-round", description: "Closes the current round without waiting (organizer)." },
      {
        name: "rest",
        description: "Has the party take a rest between fights (organizer).",
        options: [
          {
            type: "string",
            name: "type",
            description: "How long the rest is.",
            required: true,
            choices: [
              { name: "Short rest", value: "short" },
              { name: "Long rest", value: "long" },
            ],
          },
        ],
      },
      { name: "retry", description: "Asks the DM to try the held round again (organizer)." },
      { name: "repair", description: "Checks this game's channels and redraws its cards (organizer)." },
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Campaign;
  public readonly access = publicAccessPolicy;
  public readonly responseVisibility = CommandResponseVisibility.Ephemeral;
  public readonly helpDetails = [
    "/dnd setup makes this channel the hub, creates the D&D category and the DnD Admin role, and posts the hub's Create game button.",
    "The hub lists each live game with a Manage button. /dnd new does the same as Create game: its adventure channel, a -stats channel for the party, and a Table Talk thread.",
    "Everything else is run inside a game's channels: players use the buttons, and the organizer or a DnD Admin uses /dnd pause, resume, close-round, rest, retry, and repair.",
  ];

  public constructor(private readonly deps: DndCommandDependencies) {}

  public async execute(context: CommandContext): Promise<void> {
    const { interaction, responses, text } = context;
    if (!interaction.inCachedGuild()) return;
    await responses.defer();
    const subcommand = interaction.options.getSubcommand();
    const allowed = subcommand === "setup" ? this.deps.authority.isBotAdministrator(interaction) : subcommand === "new" ? await this.deps.authority.isAdmin(interaction) : true;
    if (!allowed) {
      await responses.edit(text.campaign.cmd.adminOnly);
      return;
    }
    switch (subcommand) {
      case "setup":
        return this.setup(interaction, text, responses);
      case "new":
        return this.create(interaction, text, responses);
      default:
        return this.inGame(interaction, subcommand, text, responses);
    }
  }

  private async setup(interaction: ChatInputCommandInteraction<"cached">, text: Texts, responses: CommandContext["responses"]): Promise<void> {
    const chosen = interaction.options.getChannel("hub");
    const hub = chosen !== null && chosen.type === ChannelType.GuildText ? chosen.id : interaction.channel?.type === ChannelType.GuildText ? interaction.channelId : null;
    const result = await this.deps.setup.setupGuild(interaction.guildId, hub);
    if (result.kind === "missingPermissions") {
      await responses.edit(text.campaign.cmd.setupMissing({ permissions: result.missing.join(", ") }));
      return;
    }
    await responses.edit(text.campaign.cmd.setupDone({ hub: result.settings.hubChannelId ?? "" }));
  }

  private async create(interaction: ChatInputCommandInteraction<"cached">, text: Texts, responses: CommandContext["responses"]): Promise<void> {
    const result = await this.deps.creator.create({
      guildId: interaction.guildId,
      organizerId: interaction.user.id,
      name: interaction.options.getString("name", true),
      language: interaction.options.getString("language") === "zh-TW" ? "zh-TW" : "en",
      pacing: interaction.options.getString("pacing") === "playByPost" ? "playByPost" : "live",
      players: interaction.options.getInteger("players") ?? 3,
    });
    await responses.edit(createGameText(result, text));
  }

  private async inGame(
    interaction: ChatInputCommandInteraction<"cached">,
    subcommand: string,
    text: Texts,
    responses: CommandContext["responses"],
  ): Promise<void> {
    const channel = interaction.channel;
    const ids = [interaction.channelId, ...(channel?.isThread() && channel.parentId !== null ? [channel.parentId] : [])];
    const found = await this.deps.lobby.findByChannel(interaction.guildId, ids);
    if (found === undefined) {
      await responses.edit(text.campaign.cmd.notInGame);
      return;
    }
    const { key } = found.record;
    const userId = interaction.user.id;
    const id = interaction.id;
    const done = async (result: PlayResult, success: string): Promise<void> => {
      await responses.edit(result.kind === "ok" ? success : refusalText(text, result.reason));
    };
    // The organizer, and a DnD Admin acting for them; the engine still refuses anyone else.
    const manager = subcommand === "status" ? false : await this.deps.authority.canManage(interaction, found.record);
    const control = (action: ManageAction, ownRight: () => Promise<PlayResult>): Promise<PlayResult> => (manager ? this.deps.play.manage(key, action, id) : ownRight());
    switch (subcommand) {
      case "status":
        return responses.edit(await this.status(found, text));
      case "pause":
        return done(await control("pause", () => this.deps.play.pause(key, userId, id)), text.campaign.cmd.paused);
      case "resume":
        return done(await control("resume", () => this.deps.play.continue(key, userId, id)), text.campaign.cmd.resumed);
      case "close-round":
        return done(await control("closeRound", () => this.deps.play.closeRound(key, userId, id)), text.campaign.cmd.roundClosed);
      case "rest": {
        const long = interaction.options.getString("type", true) === "long";
        return done(await control(long ? "longRest" : "shortRest", () => this.deps.play.rest(key, userId, long ? "long" : "short", id)), text.campaign.cmd.rested);
      }
      case "retry":
        return done(await control("retry", () => this.deps.play.retryPlan(key, userId, id)), text.campaign.cmd.retried);
      case "repair": {
        if (!manager) {
          await responses.edit(text.campaign.refusal.notOrganizer);
          return;
        }
        await this.deps.setup.provision(key);
        await this.deps.cards.sync(key, true);
        await responses.edit(text.campaign.cmd.repaired);
        return;
      }
    }
  }

  private async status(found: StoredRecord, text: Texts): Promise<string> {
    const { record } = found;
    if (record.lifecycle === "archived") return text.campaign.cmd.statusEnded({ name: record.name });
    const members = record.lobby.members.filter((member) => member.status !== "withdrawn").length;
    if (record.lifecycle === "lobby") return text.campaign.cmd.statusLobby({ name: record.name, count: members, max: record.lobby.maxPlayers });
    const described = await this.deps.cards.describe(record.key);
    return text.campaign.cmd.statusActive({
      name: record.name,
      scene: described?.panel?.sceneTitle ?? "",
      mode: described?.panel === null || described?.panel === undefined ? "" : text.campaign.mode[described.panel.mode],
    });
  }
}
