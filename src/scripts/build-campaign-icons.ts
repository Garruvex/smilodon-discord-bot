import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createCanvas, loadImage } from "@napi-rs/canvas";

// Turns the game-icons.net SVGs in assets/campaign/icons/svg (CC BY 3.0, see CREDITS.md there) into the 128px
// emoji Discord takes: the white glyph on a rounded coloured tile, so it reads on both light and dark themes.
// The tile colour says what kind of thing the icon is. Run with `npx tsx src/scripts/build-campaign-icons.ts`.

const tiles: Readonly<Record<string, string>> = {
  attack: "#b5312e",
  ranged: "#b5312e",
  spell: "#6d3fb5",
  move: "#2f7d4f",
  dodge: "#2f7d4f",
  dash: "#2f7d4f",
  withdraw: "#2f7d4f",
  shield: "#3a6fb0",
  potion: "#b5762e",
  rest: "#b5762e",
  shape: "#2f7d4f",
  roll: "#4752c4",
  reward: "#a8862a",
  coins: "#a8862a",
  notice: "#6d3fb5",
  hazard: "#c2571a",
  heal: "#2f7d4f",
  clue: "#3a6fb0",
  picture: "#3a6fb0",
  pause: "#5c6370",
  play: "#2f7d4f",
};

const source = resolve("assets", "campaign", "icons", "svg");
const target = resolve("assets", "emojis", "dnd");
mkdirSync(target, { recursive: true });

const size = 128;
for (const file of readdirSync(source).filter((name) => name.endsWith(".svg"))) {
  const name = file.slice(0, -".svg".length);
  // The sources carry a black square behind the white glyph; the tile replaces it.
  const svg = readFileSync(resolve(source, file), "utf8").replace('<path d="M0 0h512v512H0z"/>', "");
  const glyph = await loadImage(Buffer.from(svg));
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  context.fillStyle = tiles[name] ?? "#4752c4";
  context.beginPath();
  context.roundRect(0, 0, size, size, 26);
  context.fill();
  const inset = 14;
  context.drawImage(glyph, inset, inset, size - inset * 2, size - inset * 2);
  writeFileSync(resolve(target, `${name}.png`), canvas.toBuffer("image/png"));
  process.stdout.write(`built ${name}.png\n`);
}
