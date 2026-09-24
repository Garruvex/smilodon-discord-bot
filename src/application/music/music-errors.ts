import type { Texts } from "../i18n/texts.js";

// `message` is English and stays that way: logs and the chat model read it.
// Wherever one of these reaches a user, render it with musicErrorText.
export class MusicError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class MusicPlayerNotFoundError extends MusicError {
  public constructor() {
    super("There is no active music player in this server.");
  }
}

export class MusicSearchEmptyError extends MusicError {
  public constructor() {
    super("No playable tracks were found for that query.");
  }
}

export class MusicVoiceChannelRequiredError extends MusicError {
  public constructor() {
    super("You're not in a voice channel! Join one, then try this command again.");
  }
}

export class MusicVoiceChannelMismatchError extends MusicError {
  public constructor() {
    super("You must be in the same voice channel as the bot.");
  }
}

export class MusicChannelAccessError extends MusicError {
  public constructor() {
    super("I don't have permission to join that voice channel — I need View Channel, Connect, and Speak there.");
  }
}

export class MusicRateLimitError extends MusicError {
  public constructor(public readonly remainingSeconds: number) {
    super(
      `You're sending requests too quickly. Try again in ${remainingSeconds} second${remainingSeconds === 1 ? "" : "s"}.`,
    );
  }
}

export class MusicAutoQueueVoteUnavailableError extends MusicError {
  public constructor() {
    super("There's no autoqueue vote running right now.");
  }
}

export class MusicAutoQueueRerollEmptyError extends MusicError {
  public constructor(public readonly artist: string | null = null) {
    super(
      artist
        ? `Couldn't find enough other songs by ${artist}, so the current options stay.`
        : "Couldn't find enough other options to reroll into, so the current ones stay.",
    );
  }
}

export class MusicAutoQueueVoteClosedError extends MusicError {
  public constructor() {
    super("Voting has closed for this song; the next track is locked in.");
  }
}

export class MusicAutoQueueRerollLimitError extends MusicError {
  public constructor(public readonly limit: number) {
    super(`This vote has already been rerolled ${limit} times.`);
  }
}

// The user-facing text for a music failure, in the server's language. A
// MusicError subclass without its own message here falls back to its
// English `message`.
export function musicErrorText(error: MusicError, text: Texts): string {
  const errors = text.music.error;
  if (error instanceof MusicPlayerNotFoundError) return errors.playerNotFound;
  if (error instanceof MusicSearchEmptyError) return errors.searchEmpty;
  if (error instanceof MusicVoiceChannelRequiredError) return errors.voiceRequired;
  if (error instanceof MusicVoiceChannelMismatchError) return errors.voiceMismatch;
  if (error instanceof MusicChannelAccessError) return errors.channelAccess;
  if (error instanceof MusicRateLimitError) {
    const seconds = error.remainingSeconds;
    return seconds === 1 ? errors.rateLimitOne({ seconds }) : errors.rateLimitMany({ seconds });
  }
  if (error instanceof MusicAutoQueueVoteUnavailableError) return errors.voteUnavailable;
  if (error instanceof MusicAutoQueueRerollEmptyError) {
    return error.artist ? errors.rerollEmptyArtist({ artist: error.artist }) : errors.rerollEmpty;
  }
  if (error instanceof MusicAutoQueueVoteClosedError) return errors.voteClosed;
  if (error instanceof MusicAutoQueueRerollLimitError) return errors.rerollLimit({ limit: error.limit });
  return error.message;
}
