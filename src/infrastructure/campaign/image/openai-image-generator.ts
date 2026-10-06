import type { GeneratedImage, ImageAspect, ImageGenerator } from "../../../application/campaign/ports/image-ports.js";
import { imageFields, readImage, type OpenAiImageGeneratorOptions } from "./openai-image-http.js";

export type { OpenAiImageGeneratorOptions } from "./openai-image-http.js";

// OpenAI's image endpoint (also served by compatible providers). The picture
// comes back inline as base64 so nothing is fetched from a returned URL.
export class OpenAiImageGenerator implements ImageGenerator {
  public constructor(private readonly options: OpenAiImageGeneratorOptions) {}

  public async generate(request: { readonly prompt: string; readonly aspect?: ImageAspect; readonly timeoutMs: number; readonly references?: readonly { readonly name: string; readonly image: GeneratedImage }[] }): Promise<GeneratedImage> {
    const useReferences = (request.references?.length ?? 0) > 0 && this.options.model.startsWith("gpt-image-");
    const form = new FormData();
    if (useReferences) {
      for (const [field, value] of Object.entries(imageFields(this.options, request.aspect))) form.set(field, value);
      form.set("prompt", request.prompt.slice(0, 3_800));
      for (const [index, reference] of (request.references ?? []).entries()) {
        const extension = reference.image.mediaType === "image/jpeg" ? "jpg" : reference.image.mediaType === "image/webp" ? "webp" : "png";
        form.append("image[]", new Blob([new Uint8Array(reference.image.bytes)], { type: reference.image.mediaType }), `hero-${index + 1}.${extension}`);
      }
    }
    const response = await fetch(`${this.options.baseUrl}/images/${useReferences ? "edits" : "generations"}`, {
      method: "POST",
      headers: { ...(useReferences ? {} : { "content-type": "application/json" }), authorization: `Bearer ${this.options.apiKey}` },
      body: useReferences ? form : JSON.stringify({ ...imageFields(this.options, request.aspect), n: 1, prompt: request.prompt.slice(0, 3_800) }),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    return readImage(response);
  }
}
