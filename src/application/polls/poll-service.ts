import { randomUUID } from "node:crypto";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";

import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import { textForGuild } from "../i18n/guild-text.js";
import type { Texts } from "../i18n/texts.js";
import { renderVoteBar } from "./vote-bar.js";

export const maxPollChoices = 5;

const numberEmojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];
const defaultEmbedColor = "#22C55E";
const endedEmbedColor = "#6B7280";

export interface PollChoice {
  label: string;
  emoji: string;
}

export interface CreatePollInput {
  title: string;
  description: string | null;
  // Two to five labels; null makes a Yes/No poll.
  options: readonly string[] | null;
  durationSeconds: number | null;
}

interface ActivePoll {
  id: string;
  guildId: string | null;
  title: string;
  description: string | null;
  choices: PollChoice[];
  creatorId: string;
  authorName: string;
  message: Message;
  // One vote per user, as an index into `choices`.
  votes: Map<string, number>;
  closesAt: number | null;
  timer: NodeJS.Timeout | null;
}

type PollPayload = { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] };

export class PollService {
  private readonly polls = new Map<string, ActivePoll>();

  public constructor(private readonly guildConfigurations: Pick<GuildConfigurationProvider, "find">) {}

  public async create(interaction: ChatInputCommandInteraction, input: CreatePollInput): Promise<void> {
    const id = randomUUID().replaceAll("-", "").slice(0, 16);
    const closesAt = input.durationSeconds === null ? null : Date.now() + input.durationSeconds * 1_000;
    const text = textForGuild(this.guildConfigurations, interaction.guildId).poll;
    const choices: PollChoice[] = input.options === null
      ? [{ label: text.yes, emoji: "✅" }, { label: text.no, emoji: "❌" }]
      : input.options.map((label, index) => ({ label, emoji: numberEmojis[index]! }));
    const draft: Omit<ActivePoll, "message"> = {
      id,
      guildId: interaction.guildId,
      title: input.title,
      description: input.description,
      choices,
      creatorId: interaction.user.id,
      authorName: interaction.user.username,
      votes: new Map(),
      closesAt,
      timer: null,
    };
    await interaction.reply(this.createPayload(draft, false));
    const poll: ActivePoll = { ...draft, message: await interaction.fetchReply() };
    if (input.durationSeconds !== null) {
      poll.timer = setTimeout(() => void this.close(id), input.durationSeconds * 1_000);
      poll.timer.unref();
    }
    this.polls.set(id, poll);
  }

  public async handle(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith("poll:")) return false;
    const [, id, action] = interaction.customId.split(":");
    const poll = id ? this.polls.get(id) : undefined;
    const text = textForGuild(this.guildConfigurations, interaction.guildId).poll;
    if (!poll || poll.message.id !== interaction.message.id) {
      await interaction.reply({ content: text.inactive, flags: MessageFlags.Ephemeral });
      return true;
    }

    if (action === "end") {
      const allowed = interaction.user.id === poll.creatorId
        || interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) === true;
      if (!allowed) {
        await interaction.reply({
          content: text.endDenied,
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      this.forget(poll);
      await interaction.update(this.createPayload(poll, true));
      return true;
    }

    const index = Number(action);
    if (!Number.isInteger(index) || index < 0 || index >= poll.choices.length) return false;
    // Clicking your current pick again takes the vote back.
    if (poll.votes.get(interaction.user.id) === index) poll.votes.delete(interaction.user.id);
    else poll.votes.set(interaction.user.id, index);
    // Updating the poll message itself acknowledges the click, so voting
    // doesn't leave a trail of "vote recorded" replies.
    await interaction.update(this.createPayload(poll, false));
    return true;
  }

  public stop(): void {
    for (const poll of this.polls.values()) {
      if (poll.timer) clearTimeout(poll.timer);
    }
    this.polls.clear();
  }

  private async close(id: string): Promise<void> {
    const poll = this.polls.get(id);
    if (!poll) return;
    this.forget(poll);
    await poll.message.edit(this.createPayload(poll, true)).catch(() => undefined);
  }

  private forget(poll: ActivePoll): void {
    if (poll.timer) clearTimeout(poll.timer);
    poll.timer = null;
    this.polls.delete(poll.id);
  }

  private createPayload(poll: Omit<ActivePoll, "message">, closed: boolean): PollPayload {
    const configuration = poll.guildId ? this.guildConfigurations.find(poll.guildId) : null;
    const text = textForGuild(this.guildConfigurations, poll.guildId).poll;
    const barStyle = configuration?.music.autoQueueVoteBarStyle ?? "squares";
    const counts = poll.choices.map(() => 0);
    for (const index of poll.votes.values()) counts[index] = (counts[index] ?? 0) + 1;
    const totalVotes = poll.votes.size;
    const topVotes = Math.max(...counts);
    // Every choice tied for the most votes counts as leading; nothing leads
    // before the first vote.
    const leading = counts.map((count) => topVotes > 0 && count === topVotes);

    const lines = poll.choices.map((choice, index) => {
      const count = counts[index]!;
      const share = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
      const shownCount = leading[index] ? `**${count}**` : count;
      const tally = count === 1
        ? text.tallyOne({ count: shownCount, share })
        : text.tallyMany({ count: shownCount, share });
      const heading = leading[index]
        ? `▶ **${choice.emoji} ${choice.label}**`
        : `${choice.emoji} ${choice.label}`;
      return `${heading}\n${renderVoteBar(count, totalVotes, leading[index]!, barStyle)}  ${tally}`;
    });

    const sections = [
      ...(poll.description ? [poll.description] : []),
      lines.join("\n\n"),
      closed ? this.describeResult(poll.choices, counts, totalVotes, text) : this.describeTiming(poll.closesAt, totalVotes, text),
    ];
    const embed = new EmbedBuilder()
      .setColor(closed ? endedEmbedColor : (configuration?.embedColor as `#${string}` | undefined) ?? defaultEmbedColor)
      .setTitle(closed ? text.titleEnded({ title: poll.title }) : text.title({ title: poll.title }))
      .setDescription(sections.join("\n\n"))
      .setFooter({ text: text.footer({ name: poll.authorName }) });

    const choiceRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      poll.choices.map((choice, index) => new ButtonBuilder()
        .setCustomId(`poll:${poll.id}:${index}`)
        .setEmoji(choice.emoji)
        .setLabel(String(counts[index]))
        .setStyle(leading[index] ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(closed)),
    );
    // Discord allows five buttons per row, so ending the poll gets its own.
    const components = closed
      ? [choiceRow]
      : [choiceRow, new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`poll:${poll.id}:end`).setLabel(text.endButton).setStyle(ButtonStyle.Danger),
      )];
    return { embeds: [embed], components };
  }

  private describeTiming(closesAt: number | null, totalVotes: number, text: Texts["poll"]): string {
    const closes = closesAt === null
      ? text.openUntilEnded
      : text.closes({ time: `<t:${Math.floor(closesAt / 1_000)}:R>` });
    const soFar = totalVotes === 1 ? text.soFarOne({ count: totalVotes }) : text.soFarMany({ count: totalVotes });
    return `${closes} ${soFar}\n${text.retractHint}`;
  }

  private describeResult(
    choices: readonly PollChoice[],
    counts: readonly number[],
    totalVotes: number,
    text: Texts["poll"],
  ): string {
    if (totalVotes === 0) return text.noVotes;
    const topVotes = Math.max(...counts);
    const winners = choices.filter((_, index) => counts[index] === topVotes);
    if (winners.length === 1) {
      const choice = `${winners[0]!.emoji} ${winners[0]!.label}`;
      return totalVotes === 1
        ? text.winnerOne({ choice, top: topVotes, total: totalVotes })
        : text.winnerMany({ choice, top: topVotes, total: totalVotes });
    }
    const tied = winners.map((choice) => `${choice.emoji} ${choice.label}`).join(", ");
    return topVotes === 1
      ? text.tieOne({ choices: tied, top: topVotes, total: totalVotes })
      : text.tieMany({ choices: tied, top: topVotes, total: totalVotes });
  }
}
