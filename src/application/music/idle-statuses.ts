import { ActivityType } from "discord.js";

// What the bot shows under its name while nothing is playing anywhere. One
// status is shared by every server, so these stay in English rather than
// following a server's language. Discord puts the type's verb in front:
// "Listening to …", "Playing …", "Watching …", "Competing in …".
export type IdleStatus = {
  readonly type: ActivityType.Listening | ActivityType.Playing | ActivityType.Watching | ActivityType.Competing;
  readonly name: string;
};

export const idleStatuses: readonly IdleStatus[] = [
  { type: ActivityType.Listening, name: "your next questionable song choice 🎶" },
  { type: ActivityType.Listening, name: "your next song request 🎧" },
  { type: ActivityType.Listening, name: "the sound of an empty queue 👀" },
  { type: ActivityType.Listening, name: "requests — surprise me!" },
  { type: ActivityType.Listening, name: "someone typing a song name…" },
  { type: ActivityType.Listening, name: "the silence between songs" },
  { type: ActivityType.Listening, name: "the same song on repeat 🔁" },
  { type: ActivityType.Listening, name: "lo-fi beats to moderate to" },
  { type: ActivityType.Listening, name: "the bass drop that never came" },
  { type: ActivityType.Playing, name: "DJ for anyone in voice 🎧" },
  { type: ActivityType.Playing, name: "musical chairs with the queue" },
  { type: ActivityType.Playing, name: "dice with fate 🎲" },
  { type: ActivityType.Playing, name: "the magic 8-ball 🎱" },
  { type: ActivityType.Watching, name: "the queue warm up 🔥" },
  { type: ActivityType.Watching, name: "for song requests 👂" },
  { type: ActivityType.Watching, name: "the birthday calendar 🎂" },
  { type: ActivityType.Watching, name: "the reminders tick by ⏰" },
  { type: ActivityType.Watching, name: "the poll results roll in 🗳️" },
  { type: ActivityType.Competing, name: "the loudness war 🔊" },
];

// A random status other than the current one, so each rotation changes it.
export function nextIdleStatus(
  current: IdleStatus | null,
  random: () => number = Math.random,
): IdleStatus {
  const choices = current && idleStatuses.length > 1
    ? idleStatuses.filter((status) => status !== current)
    : idleStatuses;
  return choices[Math.floor(random() * choices.length)]!;
}
