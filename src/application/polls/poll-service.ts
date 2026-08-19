import { randomUUID } from "node:crypto";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";

export type PollChoice = "yes" | "no";

interface ActivePoll {
  id: string;
  title: string;
  description: string;
  authorName: string;
  message: Message;
  votes: Map<string, PollChoice>;
  closesAt: number | null;
  timer: NodeJS.Timeout | null;
}

export class PollService {
  private readonly polls = new Map<string, ActivePoll>();

  public async create(
    interaction: ChatInputCommandInteraction,
    title: string,
    description: string,
    durationSeconds: number | null,
  ): Promise<void> {
    const id = randomUUID().replaceAll("-", "").slice(0, 16);
    const closesAt = durationSeconds === null ? null : Date.now() + durationSeconds * 1_000;
    await interaction.reply({
      embeds: [this.createEmbed(title, description, interaction.user.username, 0, 0, closesAt, false)],
      components: [this.createButtons(id, false)],
    });
    const message = await interaction.fetchReply();
    const poll: ActivePoll = {
      id,
      title,
      description,
      authorName: interaction.user.username,
      message,
      votes: new Map(),
      closesAt,
      timer: null,
    };
    if (durationSeconds !== null) {
      poll.timer = setTimeout(() => void this.close(id), durationSeconds * 1_000);
      poll.timer.unref();
    }
    this.polls.set(id, poll);
  }

  public async handle(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith("poll:")) return false;
    const [, id, rawChoice] = interaction.customId.split(":");
    if (!id || (rawChoice !== "yes" && rawChoice !== "no")) return false;
    const poll = this.polls.get(id);
    if (!poll || poll.message.id !== interaction.message.id) {
      await interaction.reply({ content: "This poll is no longer active.", flags: MessageFlags.Ephemeral });
      return true;
    }

    poll.votes.set(interaction.user.id, rawChoice);
    await interaction.reply({ content: `Vote recorded: ${rawChoice}.`, flags: MessageFlags.Ephemeral });
    await this.render(poll, false);
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
    this.polls.delete(id);
    await this.render(poll, true).catch(() => undefined);
  }

  private async render(poll: ActivePoll, closed: boolean): Promise<void> {
    let yes = 0;
    let no = 0;
    for (const choice of poll.votes.values()) {
      if (choice === "yes") yes++;
      else no++;
    }
    await poll.message.edit({
      embeds: [this.createEmbed(poll.title, poll.description, poll.authorName, yes, no, poll.closesAt, closed)],
      components: [this.createButtons(poll.id, closed)],
    });
  }

  private createEmbed(
    title: string,
    description: string,
    authorName: string,
    yes: number,
    no: number,
    closesAt: number | null,
    closed: boolean,
  ): EmbedBuilder {
    const total = yes + no;
    const status = closed ? "Ended" : "Live";
    const timing = closesAt === null ? "No automatic closing time" : `<t:${Math.floor(closesAt / 1_000)}:R>`;
    return new EmbedBuilder()
      .setColor(closed ? "#EF4444" : "#22C55E")
      .setTitle(`[${status}] Poll: ${title}`)
      .setDescription(description)
      .addFields(
        { name: "Yes", value: String(yes), inline: true },
        { name: "No", value: String(no), inline: true },
        { name: "Total", value: String(total), inline: true },
        { name: closed ? "Closed" : "Closes", value: timing },
      )
      .setFooter({ text: `Created by ${authorName}` });
  }

  private createButtons(id: string, disabled: boolean): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`poll:${id}:yes`).setLabel("Yes").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`poll:${id}:no`).setLabel("No").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(disabled),
    );
  }
}
