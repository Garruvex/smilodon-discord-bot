import type { CardPayload } from "../../../../src/infrastructure/discord/campaign/card-payload.js";

interface Json {
  type: number;
  content?: string;
  custom_id?: string;
  label?: string;
  disabled?: boolean;
  accent_color?: number | null;
  components?: Json[];
}

export interface FlatCard {
  readonly accent: number | null;
  readonly text: string;
  readonly buttons: readonly { readonly id: string; readonly label: string; readonly disabled: boolean }[];
  readonly componentCount: number;
}

// Text and buttons of a rendered card, with Discord's own component count.
export function flatten(payload: CardPayload): FlatCard {
  const root = payload.components[0].toJSON() as unknown as Json;
  const texts: string[] = [];
  const buttons: { id: string; label: string; disabled: boolean }[] = [];
  let count = 0;
  const walk = (node: Json): void => {
    count += 1;
    if (node.type === 10 && node.content !== undefined) texts.push(node.content);
    if (node.type === 2) buttons.push({ id: node.custom_id ?? "", label: node.label ?? "", disabled: node.disabled === true });
    for (const child of node.components ?? []) walk(child);
  };
  walk(root);
  return { accent: root.accent_color ?? null, text: texts.join("\n"), buttons, componentCount: count };
}
