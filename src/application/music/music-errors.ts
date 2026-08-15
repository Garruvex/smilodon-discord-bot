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
