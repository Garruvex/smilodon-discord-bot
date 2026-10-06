import type { CampaignIconSlot } from "../../../config/application-emoji-presets.js";

export type CampaignIcon = CampaignIconSlot;

export interface IconEmoji {
  readonly id: string;
  readonly name: string;
}

// The icons a button or menu entry can carry. An icon that has not been uploaded yet is simply absent: the label stands alone.
export interface CampaignIcons {
  emoji(icon: CampaignIcon): IconEmoji | undefined;
  // The icon as message markup, for a legend in text.
  tag(icon: CampaignIcon): string | undefined;
}

export const noIcons: CampaignIcons = { emoji: () => undefined, tag: () => undefined };

// Icons read from the bot's application emoji, looked up when used (they arrive after the bot logs in).
export function applicationIcons(find: (name: string) => IconEmoji | undefined): CampaignIcons {
  const named = (icon: CampaignIcon): IconEmoji | undefined => find(`dnd_${icon}`);
  return {
    emoji: named,
    tag: (icon): string | undefined => {
      const found = named(icon);
      return found === undefined ? undefined : `<:${found.name}:${found.id}>`;
    },
  };
}
