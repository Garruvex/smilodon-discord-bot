// Single source of truth for AI-generated-image size/count bounds, shared by
// the image-generation providers (which enforce the per-image cap before a
// generated image is even returned from ChatProvider.reply) and the Discord
// delivery layer (which enforces the aggregate cap across everything one
// reply is about to attach — see chat-image-delivery.ts).
export const generatedImageLimits = {
  // Per-image cap. Both openai-responses-chat-provider.ts and
  // gemini-chat-provider.ts import this rather than each hardcoding their
  // own copy.
  maxBytesPerImage: 10 * 1024 * 1024,
  maxImagesPerReply: 4,
  // Default for the env-configurable aggregate delivery cap (see
  // CHATBOT_MAX_GENERATED_IMAGE_BYTES / ApplicationConfiguration.chatDelivery).
  // Discord's real per-request attachment limit varies by server boost tier
  // (roughly 10/50/100 MiB); this conservative default works for every
  // guild regardless of boost level — operators of guilds they know are
  // boosted can raise it via the env var without a code change.
  defaultMaxAggregateBytes: 10 * 1024 * 1024,
  // Conservative reserve per file for multipart form-data overhead
  // (boundary markers, Content-Disposition/Content-Type headers) when
  // packing images into a request against the aggregate byte cap — small
  // relative to a multi-MB image, but not negligible once several files
  // are combined in one request.
  multipartOverheadBytesPerFile: 1_024,
} as const;
