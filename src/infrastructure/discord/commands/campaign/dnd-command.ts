import { isTimeOfDay, isWeather } from "../../../../domain/campaign/rules/world-rules.js";
import { worldLine } from "../../campaign/world-text.js";
import { ChannelType, type ChatInputCommandInteraction } from "discord.js";

import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { CampaignLobbyService } from "../../../../application/campaign/campaign-lobby-service.js";
import type { CampaignPlayController, ManageAction, PlayResult } from "../../../../application/campaign/campaign-play-controller.js";
import type { StoredRecord } from "../../../../application/campaign/ports/campaign-record.js";
import { texts, type Texts } from "../../../../application/i18n/texts.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import type { CampaignAuthority } from "../../campaign/campaign-authority.js";
import type { CampaignGameCreator } from "../../campaign/campaign-game-creator.js";
import { createGameText } from "../../campaign/campaign-game-creator.js";
import type { CampaignCardService } from "../../campaign/campaign-card-service.js";
import type { CharacterLibrary } from "../../../../application/campaign/library/character-library.js";
import type { AdventureIntake } from "../../campaign/adventure-intake.js";
import type { CharacterLibraryComponentHandler } from "../../components/character-library-component-handler.js";
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
        options: [
          { type: "channel", name: "hub", description: "Use this channel as the hub (default: a new channel).", guildTextOnly: true },
          { type: "string", name: "language", description: "Language for the D&D hub and new games.", choices: [{ name: "English", value: "en" }, { name: "繁體中文", value: "zh-TW" }] },
        ],
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
          { type: "string", name: "adventure", description: "The adventure to play: its title or part of it (default: the one that comes with the bot).", maxLength: 100 },
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
        options: [
          { type: "attachment", name: "file", description: "The adventure file (YAML or JSON).", required: true },
          { type: "string", name: "language", description: "Language this adventure is written and played in.", required: true, choices: [{ name: "English", value: "en" }, { name: "繁體中文", value: "zh-TW" }] },
        ],
      },
      { name: "adventures", description: "Lists this server's adventures: review a draft, remove one, or restore it." },
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
        description: "Take a rest between fights. Players propose it and the table votes.",
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
        name: "rest-vote",
        description: "Answer a rest a player has proposed.",
        options: [
          {
            type: "string",
            name: "answer",
            description: "Do you agree to rest?",
            required: true,
            choices: [
              { name: "Agree", value: "agree" },
              { name: "Not now", value: "decline" },
            ],
          },
        ],
      },
      { name: "companions-away", description: "Send all your companions away (between fights)." },
      {
        name: "hit-dice",
        description: "Spend Hit Dice to heal after a short rest (your own hero).",
        options: [{ type: "integer", name: "count", description: "How many Hit Dice to spend.", required: true, minValue: 1, maxValue: 20 }],
      },
      {
        name: "level",
        description: "Raises every living hero to a level, for milestone leveling (organizer).",
        options: [{ type: "integer", name: "level", description: "The level to raise the party to.", required: true, minValue: 2, maxValue: 20 }],
      },
      {
        name: "time",
        description: "Corrects the story's day, time of day or weather (organizer).",
        options: [
          { type: "integer", name: "day", description: "The day of the story (the first day is 1).", minValue: 1, maxValue: 10000 },
          { type: "string", name: "time", description: "The time of day.", choices: [{ name: "Dawn", value: "dawn" }, { name: "Morning", value: "morning" }, { name: "Midday", value: "midday" }, { name: "Afternoon", value: "afternoon" }, { name: "Dusk", value: "dusk" }, { name: "Night", value: "night" }] },
          { type: "string", name: "weather", description: "The weather (none clears it).", choices: [{ name: "Clear", value: "clear" }, { name: "Rain", value: "rain" }, { name: "Storm", value: "storm" }, { name: "Fog", value: "fog" }, { name: "Snow", value: "snow" }, { name: "Wind", value: "wind" }, { name: "None", value: "none" }] },
          { type: "string", name: "note", description: "Why it is being corrected (kept in the game's history).", maxLength: 200 },
        ],
      },
      {
        name: "move",
        description: "Settles a scene change the party is waiting on (organizer).",
        options: [
          {
            type: "string",
            name: "decision",
            description: "Send the party now, or keep it where it is.",
            required: true,
            choices: [
              { name: "Go now", value: "go" },
              { name: "Stay here", value: "stay" },
            ],
          },
        ],
      },
      { name: "retry", description: "Asks the DM to try the held round again (organizer)." },
      { name: "repair", description: "Checks this game's channels and redraws its cards (organizer)." },
      {
        name: "size",
        description: "Changes how many players the game takes (organizer).",
        options: [{ type: "integer", name: "players", description: "Seats in the game, 1 to 6. Never fewer than the players already in it.", required: true, minValue: 1, maxValue: 6 }],
      },
      { name: "reopen", description: "Opens a finished game again, paused where it stopped (organizer)." },
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Campaign;
  public readonly access = publicAccessPolicy;
  public readonly responseVisibility = CommandResponseVisibility.Ephemeral;
  public readonly helpDetails = [
    "/dnd setup creates the D&D category with a #dnd-games hub channel (or uses the channel you give it), the Public/Private Games and Parties forums, and the DnD Admin and Private Games roles, and posts the hub's Create game button.",
    "The hub is the same things as buttons: Create game, My Characters, New character, Import character, Upload adventure, Write an adventure and a short guide, with each live game listed below and a Manage button on it. /dnd new does the same as Create game: a Games post and a matching Parties post, in the public or private forum pair its visibility picks.",
    "Everything else is run inside a game's posts: players use the buttons, and the organizer or a DnD Admin uses /dnd pause, resume, close-round, move, size, rest, level, retry, repair, and reopen (for a finished game).",
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
        : subcommand === "new" || subcommand === "upload-adventure" || subcommand === "adventures" || subcommand === "author"
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
      case "adventures":
        return this.deps.intake.adventures(interaction);
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
    const screen = await this.deps.libraryScreens.homeScreen(interaction.user.id, await this.characterLanguage(interaction));
    await interaction.editReply({ content: screen.content, components: screen.components });
  }

  // Reads an uploaded character file as data and makes it a new character in
  // the asker's library, or says exactly why it cannot.
  private async importCharacter(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
    const file = interaction.options.getAttachment("file");
    await interaction.editReply({ content: await this.deps.libraryScreens.importFromFile(interaction.user.id, await this.characterLanguage(interaction), file === null ? null : { url: file.url, size: file.size }) });
  }

  private async characterLanguage(interaction: ChatInputCommandInteraction<"cached">): Promise<"en" | "zh-TW"> {
    const channel = interaction.channel;
    const ids = [interaction.channelId, ...(channel?.isThread() && channel.parentId !== null ? [channel.parentId] : [])];
    const game = await this.deps.lobby.findByChannel(interaction.guildId, ids);
    return game?.record.language ?? await this.deps.authority.guildLanguage(interaction.guildId);
  }

  private async setup(interaction: ChatInputCommandInteraction<"cached">, text: Texts, responses: CommandContext["responses"]): Promise<void> {
    const chosen = interaction.options.getChannel("hub");
    // No channel given: the hub is a new #dnd-games in the D&D category (or the one already there).
    const hub = chosen !== null && chosen.type === ChannelType.GuildText ? chosen.id : null;
    const selected = interaction.options.getString("language");
    const result = await this.deps.setup.setupGuild(interaction.guildId, hub, selected === "zh-TW" ? "zh-TW" : selected === "en" ? "en" : await this.deps.authority.guildLanguage(interaction.guildId));
    if (result.kind === "missingPermissions") {
      await responses.edit(text.campaign.cmd.setupMissing({ permissions: result.missing.join(", ") }));
      return;
    }
    await responses.edit(texts[result.settings.language ?? "en"].campaign.cmd.setupDone({ hub: result.settings.hubChannelId ?? "" }));
  }

  private async create(interaction: ChatInputCommandInteraction<"cached">, text: Texts, responses: CommandContext["responses"]): Promise<void> {
    const language = interaction.options.getString("language") === "zh-TW" ? "zh-TW" : interaction.options.getString("language") === "en" ? "en" : await this.deps.authority.guildLanguage(interaction.guildId);
    const named = this.deps.creator.findAdventure(interaction.guildId, language, interaction.options.getString("adventure"));
    if (named.kind !== "found") {
      const t = text.campaign.cmd;
      await responses.edit(named.kind === "none" ? t.adventureNotFound({ list: named.available.join(", ") }) : t.adventureAmbiguous({ list: named.matches.join(", ") }));
      return;
    }
    const result = await this.deps.creator.create({
      guildId: interaction.guildId,
      organizerId: interaction.user.id,
      name: interaction.options.getString("name", true),
      language,
      ...(named.adventureId === undefined ? {} : { adventureId: named.adventureId }),
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
      case "move": {
        const go = interaction.options.getString("decision", true) === "go";
        // A DnD Admin acts for the organizer: no user is named, so the engine sees the organizer.
        return done(await this.deps.play.settleMove(key, manager ? null : userId, go ? "go" : "stay", id), go ? text.campaign.cmd.moveSent : text.campaign.cmd.moveHeld);
      }
      case "rest": {
        const long = interaction.options.getString("type", true) === "long";
        // A player who is not the organizer proposes the rest; the table answers with /dnd rest-vote.
        if (!manager && found.record.organizerId !== userId) return done(await this.deps.play.proposeRest(key, userId, long ? "long" : "short", id), text.campaign.cmd.restProposed);
        return done(await control(long ? "longRest" : "shortRest", () => this.deps.play.queueRest(key, userId, long ? "long" : "short", id)), long ? text.campaign.cmd.rested : text.campaign.cmd.shortRested);
      }
      case "rest-vote": {
        const agree = interaction.options.getString("answer", true) === "agree";
        return done(await this.deps.play.answerRestVote(key, userId, agree, id), agree ? text.campaign.cmd.restAgreed : text.campaign.cmd.restNotNow);
      }
      case "companions-away":
        return done(await this.deps.play.dismissCompanions(key, userId, id), text.campaign.cmd.companionsAway);
      case "hit-dice": {
        const count = interaction.options.getInteger("count", true);
        return done(await this.deps.play.spendHitDice(key, userId, count, id), text.campaign.cmd.hitDiceAsked);
      }
      case "level": {
        const level = interaction.options.getInteger("level", true);
        // A DnD Admin acts for the organizer: no user is named, so the engine sees the organizer.
        return done(await this.deps.play.raiseLevel(key, manager ? null : userId, level, id), text.campaign.cmd.levelRaised({ level }));
      }
      case "time": {
        const day = interaction.options.getInteger("day");
        const time = interaction.options.getString("time");
        const weather = interaction.options.getString("weather");
        const note = interaction.options.getString("note");
        if (day === null && time === null && weather === null) return responses.edit(text.campaign.world.nothingToSet);
        const patch = {
          ...(day === null ? {} : { day }),
          ...(time !== null && isTimeOfDay(time) ? { time } : {}),
          ...(weather === "none" ? { weather: null } : weather !== null && isWeather(weather) ? { weather } : {}),
          ...(note === null ? {} : { note }),
        };
        const result = await this.deps.play.setWorld(key, manager ? null : userId, patch, id);
        const shown = await this.deps.cards.describe(key);
        return done(result, text.campaign.world.corrected({ world: worldLine(shown?.panel?.world, text) }));
      }
      case "retry":
        return done(await control("retry", () => this.deps.play.retryPlan(key, userId, id)), text.campaign.cmd.retried);
      case "size": {
        if (!manager) {
          await responses.edit(text.campaign.refusal.notOrganizer);
          return;
        }
        const players = interaction.options.getInteger("players", true);
        const resized = await this.deps.lobby.setPartySize(key, interaction.user.id === found.record.organizerId ? userId : null, players);
        if (resized.kind === "refused") {
          await responses.edit(refusalText(text, resized.reason));
          return;
        }
        await this.deps.cards.sync(key);
        await responses.edit(text.campaign.cmd.sized({ count: players }));
        return;
      }
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
