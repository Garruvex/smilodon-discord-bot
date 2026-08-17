export const yohtaApplicationEmojiAssets = [
  { slot: "completed", name: "progressed", file: "progressed.webp" },
  { slot: "remaining", name: "progress", file: "progress.webp" },
  { slot: "playing", name: "yhota_run3", file: "yhota_run3.webp" },
  { slot: "paused", name: "yohta_stop", file: "yohta_stop.webp" },
  { slot: "ending", name: "canned_fish", file: "canned_fish.webp" },
] as const;

export type YohtaEmojiSlot = typeof yohtaApplicationEmojiAssets[number]["slot"];
