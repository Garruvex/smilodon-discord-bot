import type { CharacterPortraitStore, GeneratedImage, ImageGenerator, PortraitSlot, PortraitStylizer } from "../../../src/application/campaign/ports/image-ports.js";

// Stand-ins for the portrait store and the image models, shared by the portrait tests.

export class MemoryPortraitStore implements CharacterPortraitStore {
  public readonly images = new Map<string, GeneratedImage>();
  public readonly notes = new Map<string, string>();
  public saveImage(characterId: string, slot: PortraitSlot, image: GeneratedImage): Promise<void> {
    this.images.set(`${characterId}:${slot}`, image);
    return Promise.resolve();
  }
  public loadImage(characterId: string, slot: PortraitSlot): Promise<GeneratedImage | undefined> {
    return Promise.resolve(this.images.get(`${characterId}:${slot}`));
  }
  public removeImage(characterId: string, slot: PortraitSlot): Promise<void> {
    this.images.delete(`${characterId}:${slot}`);
    return Promise.resolve();
  }
  public saveNote(characterId: string, text: string): Promise<void> {
    this.notes.set(characterId, text);
    return Promise.resolve();
  }
  public loadNote(characterId: string): Promise<string | undefined> {
    return Promise.resolve(this.notes.get(characterId));
  }
  public removeAll(characterId: string): Promise<void> {
    for (const key of [...this.images.keys()]) if (key.startsWith(`${characterId}:`)) this.images.delete(key);
    this.notes.delete(characterId);
    return Promise.resolve();
  }
  public sweepDrafts(): Promise<number> {
    return Promise.resolve(0);
  }
}

export class Stylizer implements PortraitStylizer {
  public readonly requests: { source: GeneratedImage; prompt: string }[] = [];
  public fail = false;
  public stylize(request: { source: GeneratedImage; prompt: string }): Promise<GeneratedImage> {
    this.requests.push(request);
    return this.fail ? Promise.reject(new Error("The provider is busy.")) : Promise.resolve({ bytes: Buffer.from("styled"), mediaType: "image/png" });
  }
}

export class Painter implements ImageGenerator {
  public readonly prompts: string[] = [];
  public generate(request: { prompt: string }): Promise<GeneratedImage> {
    this.prompts.push(request.prompt);
    return Promise.resolve({ bytes: Buffer.from("painted"), mediaType: "image/png" });
  }
}

export const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("upload")]);

