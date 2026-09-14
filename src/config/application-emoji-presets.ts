export const yohtaApplicationEmojiAssets = [
  { slot: "completed", name: "progressed", file: "progressed.webp" },
  { slot: "remaining", name: "progress", file: "progress.webp" },
  { slot: "playing", name: "yhota_run3", file: "yhota_run3.webp" },
  { slot: "paused", name: "yohta_stop", file: "yohta_stop.webp" },
  { slot: "ending", name: "canned_fish", file: "canned_fish.webp" },
] as const;

export type YohtaEmojiSlot = typeof yohtaApplicationEmojiAssets[number]["slot"];

// The spinning-disc indicator shown next to the Now Playing / Lyrics panel
// titles: "disc_spin" while actively playing, "disc_static" otherwise
// (paused or idle). Same application-emoji mechanism as the yohta preset
// above, just a separate directory/group so the two can be synced or go
// missing independently.
export const musicDiscEmojiAssets = [
  { slot: "playing", name: "disc_spin", file: "spin.gif" },
  { slot: "idle", name: "disc_static", file: "static.png" },
] as const;

export type MusicDiscEmojiSlot = typeof musicDiscEmojiAssets[number]["slot"];

export const applicationEmojiPresets = [
  { directory: "yohta", assets: yohtaApplicationEmojiAssets },
  { directory: "disc", assets: musicDiscEmojiAssets },
] as const;
