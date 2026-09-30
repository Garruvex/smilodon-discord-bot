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

// Icons for the D&D game's buttons and menus, from game-icons.net (CC BY 3.0; see assets/campaign/icons/CREDITS.md).
// Built by src/scripts/build-campaign-icons.ts.
export const campaignIconAssets = [
  { slot: "attack", name: "dnd_attack", file: "attack.png" },
  { slot: "ranged", name: "dnd_ranged", file: "ranged.png" },
  { slot: "spell", name: "dnd_spell", file: "spell.png" },
  { slot: "move", name: "dnd_move", file: "move.png" },
  { slot: "dodge", name: "dnd_dodge", file: "dodge.png" },
  { slot: "dash", name: "dnd_dash", file: "dash.png" },
  { slot: "withdraw", name: "dnd_withdraw", file: "withdraw.png" },
  { slot: "shield", name: "dnd_shield", file: "shield.png" },
  { slot: "potion", name: "dnd_potion", file: "potion.png" },
  { slot: "rest", name: "dnd_rest", file: "rest.png" },
  { slot: "shape", name: "dnd_shape", file: "shape.png" },
  { slot: "roll", name: "dnd_roll", file: "roll.png" },
  { slot: "reward", name: "dnd_reward", file: "reward.png" },
  { slot: "coins", name: "dnd_coins", file: "coins.png" },
  { slot: "notice", name: "dnd_notice", file: "notice.png" },
  { slot: "hazard", name: "dnd_hazard", file: "hazard.png" },
  { slot: "heal", name: "dnd_heal", file: "heal.png" },
  { slot: "clue", name: "dnd_clue", file: "clue.png" },
  { slot: "picture", name: "dnd_picture", file: "picture.png" },
  { slot: "pause", name: "dnd_pause", file: "pause.png" },
  { slot: "play", name: "dnd_play", file: "play.png" },
] as const;

export type CampaignIconSlot = typeof campaignIconAssets[number]["slot"];

export const applicationEmojiPresets = [
  { directory: "yohta", assets: yohtaApplicationEmojiAssets },
  { directory: "disc", assets: musicDiscEmojiAssets },
  { directory: "dnd", assets: campaignIconAssets },
] as const;
