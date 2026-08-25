import {
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type MessageContextMenuCommandInteraction,
} from "discord.js";

import { CommandResponseVisibility } from "./command.js";

export class CommandResponses {
  public constructor(
    private readonly interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
    private readonly visibility: CommandResponseVisibility,
  ) {}

  public async reply(options: string | InteractionReplyOptions): Promise<void> {
    const payload: InteractionReplyOptions = typeof options === "string"
      ? { content: options }
      : options;
    await this.interaction.reply(
      this.visibility === CommandResponseVisibility.Ephemeral
        ? { ...payload, flags: MessageFlags.Ephemeral }
        : payload,
    );
  }

  public async defer(): Promise<void> {
    await this.interaction.deferReply(
      this.visibility === CommandResponseVisibility.Ephemeral
        ? { flags: MessageFlags.Ephemeral }
        : {},
    );
  }

  public async edit(options: string | InteractionEditReplyOptions): Promise<void> {
    await this.interaction.editReply(options);
  }

  public deleteAfter(milliseconds: number): void {
    const timer = setTimeout(() => {
      void this.interaction.deleteReply().catch(() => undefined);
    }, milliseconds);
    timer.unref();
  }

  public async error(message: string, title = "Command error"): Promise<void> {
    const embed = new EmbedBuilder()
      .setColor("Red")
      .setTitle(title)
      .setDescription(`❌ | **${message}**`);
    if (this.interaction.deferred && !this.interaction.replied) {
      await this.edit({ content: null, embeds: [embed] });
    } else if (this.interaction.replied) {
      await this.interaction.followUp({
        embeds: [embed],
        flags: this.visibility === CommandResponseVisibility.Ephemeral
          ? MessageFlags.Ephemeral
          : undefined,
      });
    } else {
      await this.reply({ embeds: [embed] });
    }
  }
}
