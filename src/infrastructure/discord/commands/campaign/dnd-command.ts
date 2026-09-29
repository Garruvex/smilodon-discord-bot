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
import type { CharacterLibrary } from "../../../../application/campaign/library/character-library.js";
import type { AdventureIntake } from "../../campaign/adventure-intake.js";
import { languageOf, type CharacterLibraryComponentHandler } from "../../components/character-library-component-handler.js";
import type { CampaignSetupService } from "../../campaign/campaign-setup-service.js";
import { refusalText } from "../../campaign/refusal-text.js";
import { repairText } from "../../campaign/repair-text.js";

export interface DndCommandDependencies {
  readonly lobby: CampaignLobbyService;
  readonly play: CampaignPlayController;
  readonly setup: CampaignSetupService;
  readonly cards: CampaignCardService;
  readonly creator: CampaignGameCreator;
  readonly authority: CampaignAuthority;
  // The character library and its opening screen (My Characters).
  readonly library: CharacterLibrary;
  readonly libraryScreens: Pick<CharacterLibraryComponentHandler, "homeScreen" | "importFromFile">;
  // Uploading an adventure file and the Adventure Author.
  readonly intake: AdventureIntake;
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
        description: "Sets this server up for D&D: a D&D category with a games hub channel.",
        options: [{ type: "channel", name: "hub", description: "Use this channel as the hub (default: a new #dnd-games).", guildTextOnly: true }],
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
          {
            type: "string",
            name: "visibility",
            description: "Who can watch once the game starts (default: everyone).",
            choices: [
              { name: "Everyone who can see the category", value: "open" },
              { name: "Players only", value: "membersOnly" },
            ],
          },
        ],
      },
      { name: "characters", description: "Opens your character library: build, view, export and delete characters." },
      {
        name: "import-character",
        description: "Adds a character from an exported file to your library.",
        options: [{ type: "attachment", name: "file", description: "The character file (.json) exported from My Characters.", required: true }],
      },
      {
        name: "upload-adventure",
        description: "Adds an adventure from a file to this server, after checks and your approval.",
        options: [{ type: "attachment", name: "file", description: "The adventure file (YAML or JSON).", required: true }],
      },
      {
        name: "author",
        description: "Has the Adventure Author write an adventure from an idea or your notes.",
        options: [
          { type: "string", name: "idea", description: "What the adventure is about.", maxLength: 1000 },
          {
            type: "string",
            name: "language",
            description: "The language to write it in (default: English).",
            choices: [
              { name: "English", value: "en" },
              { name: "繁體中文", value: "zh-TW" },
            ],
          },
          { type: "attachment", name: "notes", description: "Your own notes to build from (text or Markdown)." },
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
      {
        name: "level",
        description: "Raises every living hero to a level, for milestone leveling (organizer).",
        options: [{ type: "integer", name: "level", description: "The level to raise the party to.", required: true, minValue: 2, maxValue: 20 }],
      },
      { name: "retry", description: "Asks the DM to try the held round again (organizer)." },
      { name: "repair", description: "Checks this game's channels and redraws its cards (organizer)." },
      { name: "reopen", description: "Opens a finished game again, paused where it stopped (organizer)." },
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Campaign;
  public readonly access = publicAccessPolicy;
  public readonly responseVisibility = CommandResponseVisibility.Ephemeral;
  public readonly helpDetails = [
    "/dnd setup creates the D&D category with a #dnd-games hub channel (or uses the channel you give it), the Public/Private Games and Parties forums, and the DnD Admin and Private Games roles, and posts the hub's Create game button.",
    "The hub is the same things as buttons: Create game, My Characters, New character, Import character, Upload adventure, Write an adventure and a short guide, with each live game listed below and a Manage button on it. /dnd new does the same as Create game: a Games post and a matching Parties post, in the public or private forum pair its visibility picks.",
    "Everything else is run inside a game's posts: players use the buttons, and the organizer or a DnD Admin uses /dnd pause, resume, close-round, rest, level, retry, repair, and reopen (for a finished game).",
  ];

  public constructor(private readonly deps: DndCommandDependencies) {}

  public async execute(context: CommandContext): Promise<void> {
    const { interaction, responses, text } = context;
    if (!interaction.inCachedGuild()) return;
    await responses.defer();
    const subcommand = interaction.options.getSubcommand();
    const allowed =
      subcommand === "setup"
        ? this.deps.authority.isBotAdministrator(interaction)
        : subcommand === "new" || subcommand === "upload-adventure" || subcommand === "author"
          ? await this.deps.authority.isAdmin(interaction)
          : true;
    if (!allowed) {
      await responses.edit(text.campaign.cmd.adminOnly);
      return;
    }
    switch (subcommand) {
      case "characters":
        return this.characters(interaction);
      case "import-character":
        return this.importCharacter(interaction);
      case "upload-adventure":
        return this.deps.intake.upload(interaction);
      case "author":
        return this.deps.intake.author(interaction);
      case "setup":
        return this.setup(interaction, text, responses);
      case "new":
        return this.create(interaction, text, responses);
      default:
        return this.inGame(interaction, subcommand, text, responses);
    }
  }

  // My Characters: a private screen for the person who asked, in their own client's language.
  private async characters(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
    const screen = await this.deps.libraryScreens.homeScreen(interaction.user.id, languageOf(interaction));
    await interaction.editReply({ content: screen.content, components: screen.components });
  }

  // Reads an uploaded character file as data and makes it a new character in
  // the asker's library, or says exactly why it cannot.
  private async importCharacter(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
    const file = interaction.options.getAttachment("file");
    await interaction.editReply({ content: await this.deps.libraryScreens.importFromFile(interaction.user.id, languageOf(interaction), file === null ? null : { url: file.url, size: file.size }) });
  }

  private async setup(interaction: ChatInputCommandInteraction<"cached">, text: Texts, responses: CommandContext["responses"]): Promise<void> {
    const chosen = interaction.options.getChannel("hub");
    // No channel given: the hub is a new #dnd-games in the D&D category (or the one already there).
    const hub = chosen !== null && chosen.type === ChannelType.GuildText ? chosen.id : null;
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
      visibility: interaction.options.getString("visibility") === "membersOnly" ? "membersOnly" : "open",
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
      case "level": {
        const level = interaction.options.getInteger("level", true);
        // A DnD Admin acts for the organizer: no user is named, so the engine sees the organizer.
        return done(await this.deps.play.raiseLevel(key, manager ? null : userId, level, id), text.campaign.cmd.levelRaised({ level }));
      }
      case "retry":
        return done(await control("retry", () => this.deps.play.retryPlan(key, userId, id)), text.campaign.cmd.retried);
      case "reopen": {
        if (!manager) {
          await responses.edit(text.campaign.refusal.notOrganizer);
          return;
        }
        const reopened = await this.deps.lobby.reopen(key);
        if (reopened.kind === "refused") {
          await responses.edit(refusalText(text, reopened.reason));
          return;
        }
        // The hub lists the game again and its cards show it as paused.
        await this.deps.cards.sync(key);
        await responses.edit(text.campaign.cmd.reopened);
        return;
      }
      case "repair": {
        if (!manager) {
          await responses.edit(text.campaign.refusal.notOrganizer);
          return;
        }
        await responses.edit(repairText(await this.deps.setup.repair(key), text));
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
