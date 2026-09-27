// Scene pictures (plan §6). Both ports are optional in the running bot: with
// no image model configured there is no generator and no picture is asked for.

export interface GeneratedImage {
  readonly bytes: Buffer;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
}

export interface ImageGenerator {
  // One picture from a prompt, or a thrown error (a timeout, a refusal, a provider failure).
  generate(request: { readonly prompt: string; readonly timeoutMs: number }): Promise<GeneratedImage>;
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
