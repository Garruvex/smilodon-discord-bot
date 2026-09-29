// Scene pictures (plan §6). Both ports are optional in the running bot: with
// no image model configured there is no generator and no picture is asked for.

export interface GeneratedImage {
  readonly bytes: Buffer;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
}

// The shape of a picture: a place is wide, a face is square. The provider maps
// it to the sizes its model offers.
export type ImageAspect = "square" | "wide" | "tall";

// Why a provider gave nothing. A refusal (its content rules said no) or a bad
// request would fail again the same way, so it is not tried a second time;
// a timeout, a rate limit or a server error may pass.
export class ImageProviderError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ImageProviderError";
  }
}

export interface ImageGenerator {
  // One picture from a prompt, or a thrown error (an ImageProviderError, or a timeout).
  generate(request: { readonly prompt: string; readonly aspect?: ImageAspect; readonly timeoutMs: number }): Promise<GeneratedImage>;
}

// A made picture kept until it has been posted, so a failed post is retried
// from the saved picture instead of asking (and paying) the model again. A
// missing picture reads as undefined.
export interface ImageAssetStore {
  save(key: { readonly guildId: string; readonly campaignId: string }, sceneId: string, image: GeneratedImage): Promise<void>;
  load(key: { readonly guildId: string; readonly campaignId: string }, sceneId: string): Promise<GeneratedImage | undefined>;
  remove(key: { readonly guildId: string; readonly campaignId: string }, sceneId: string): Promise<void>;
}

// Where a finished picture goes: the game's Adventure channel.
export interface SceneImageSink {
  post(channelId: string, image: GeneratedImage, caption: string): Promise<void>;
}

// Turns a picture a player uploaded into a character portrait: the source is
// the reference, the prompt says what to make of it. A thrown error is a
// timeout, a refusal or a provider failure.
export interface PortraitStylizer {
  stylize(request: { readonly source: GeneratedImage; readonly prompt: string; readonly timeoutMs: number }): Promise<GeneratedImage>;
}

// Where a library character's portrait lives, across servers and games. A
// slot is "portrait" (the one in use), "candidate" (made, waiting for a yes)
// or "source" (the upload a candidate was made from, kept only until the
// player decides). A small note (the style a candidate was made in) rides
// along.
export type PortraitSlot = "portrait" | "candidate" | "source";
export interface CharacterPortraitStore {
  saveImage(characterId: string, slot: PortraitSlot, image: GeneratedImage): Promise<void>;
  loadImage(characterId: string, slot: PortraitSlot): Promise<GeneratedImage | undefined>;
  removeImage(characterId: string, slot: PortraitSlot): Promise<void>;
  saveNote(characterId: string, text: string): Promise<void>;
  loadNote(characterId: string): Promise<string | undefined>;
  // Everything kept for a character (it was deleted).
  removeAll(characterId: string): Promise<void>;
  // Drops candidates and sources not touched for this long; portraits stay.
  sweepDrafts(olderThanMs: number): Promise<number>;
}
