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
  public constructor(remainingSeconds: number) {
    super(
      `You're sending requests too quickly. Try again in ${remainingSeconds} second${remainingSeconds === 1 ? "" : "s"}.`,
    );
  }
}
