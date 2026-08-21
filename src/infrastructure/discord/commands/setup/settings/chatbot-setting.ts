import {
  formatRoleGroupList,
  roleGroupDescriptions,
} from "../../../../../application/access/role-group-descriptions.js";
import { CHAT_LIMITS } from "../../../../../config/guild-configuration-limits.js";
import type { MutationSettingDefinition } from "./setting-definition.js";

export const chatbotSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "chatbot",
  description: "Configures mention-based AI replies.",
  configureOptions: () => [
    { type: "boolean", name: "enabled", description: "Reply when permitted users mention the bot." },
    { type: "role", name: "role", description: "Adds a role allowed to use mention chat." },
    { type: "channel", name: "channel", description: "Adds a text channel where mention chat is allowed.", guildTextOnly: true },
    {
      type: "integer", name: "cooldown-seconds", description: "Per-user delay between requests.",
      minValue: CHAT_LIMITS.cooldownSeconds.min, maxValue: CHAT_LIMITS.cooldownSeconds.max,
    },
    { type: "string", name: "denied-message", description: "Playful response shown to users without access.", maxLength: 500 },
    { type: "string", name: "denied-link-url", description: "Optional link button URL shown with the denied message. Use \"none\" to remove it." },
    { type: "string", name: "denied-link-label", description: "Label for the denied-message link button.", maxLength: 80 },
    { type: "boolean", name: "web-search", description: "Allow the model to search the public web when needed." },
    { type: "boolean", name: "tool-calling", description: "Allow the model to call bot functions mid-reply (dice, 8-ball, booru, lookups)." },
    { type: "boolean", name: "image-input", description: "Allow bounded image attachments from Discord." },
    { type: "boolean", name: "image-generation", description: "Allow the model to generate images in mention chat." },
    { type: "boolean", name: "include-sources", description: "Include web citation links in replies." },
    {
      type: "integer", name: "max-images", description: "Maximum images accepted per request.",
      minValue: CHAT_LIMITS.maxImagesPerRequest.min, maxValue: CHAT_LIMITS.maxImagesPerRequest.max,
    },
    { type: "attachment", name: "personality", description: "Upload the guild personality as a Markdown file." },
    { type: "boolean", name: "use-default-personality", description: "Remove the uploaded personality and use the built-in/default file." },
    { type: "attachment", name: "examples", description: "Upload example character exchanges as a Markdown file." },
    { type: "boolean", name: "use-default-examples", description: "Remove the uploaded examples file." },
    { type: "boolean", name: "persona-drift", description: "Experimental: let the character's mood/quirks slowly evolve from conversation activity." },
    { type: "boolean", name: "reset-persona-drift", description: "Wipe the character's evolved mood/quirk history and start over." },
  ],
  handle: async (context, deps, previousProfile, input) => {
    const enabled = context.interaction.options.getBoolean("enabled");
    const role = context.interaction.options.getRole("role");
    const channel = context.interaction.options.getChannel("channel");
    const cooldown = context.interaction.options.getInteger("cooldown-seconds");
    const deniedMessage = context.interaction.options.getString("denied-message");
    const deniedLinkUrl = context.interaction.options.getString("denied-link-url");
    const deniedLinkLabel = context.interaction.options.getString("denied-link-label");
    const webSearch = context.interaction.options.getBoolean("web-search");
    const toolCalling = context.interaction.options.getBoolean("tool-calling");
    const imageInput = context.interaction.options.getBoolean("image-input");
    const imageGeneration = context.interaction.options.getBoolean("image-generation");
    const includeSources = context.interaction.options.getBoolean("include-sources");
    const maxImages = context.interaction.options.getInteger("max-images");
    const personality = context.interaction.options.getAttachment("personality");
    const useDefaultPersonality = context.interaction.options.getBoolean("use-default-personality");
    if (personality && useDefaultPersonality === true) {
      return { ok: false, message: "Choose either a personality upload or the default personality, not both." };
    }
    const examples = context.interaction.options.getAttachment("examples");
    const useDefaultExamples = context.interaction.options.getBoolean("use-default-examples");
    if (examples && useDefaultExamples === true) {
      return { ok: false, message: "Choose either an examples upload or removing examples, not both." };
    }
    if (enabled !== null) input.chatbotEnabled = enabled;
    if (role) {
      input.chatbotRoleIds = [...new Set([...previousProfile.roles.chatbot, role.id])];
    }
    if (channel) {
      input.chatbotChannelIds = [...new Set([...previousProfile.channels.chatbot, channel.id])];
    }
    if (cooldown !== null) input.chatbotCooldownSeconds = cooldown;
    if (deniedMessage) input.chatbotDeniedMessage = deniedMessage;
    if (deniedLinkUrl !== null) {
      input.chatbotDeniedLinkUrl = deniedLinkUrl.trim().toLowerCase() === "none" ? null : deniedLinkUrl;
    }
    if (deniedLinkLabel !== null) input.chatbotDeniedLinkLabel = deniedLinkLabel;
    if (webSearch !== null) input.chatbotWebSearchMode = webSearch ? "auto" : "off";
    if (toolCalling !== null) input.chatbotToolCallingEnabled = toolCalling;
    if (imageInput !== null) input.chatbotImageInputEnabled = imageInput;
    if (imageGeneration !== null) input.chatbotImageGenerationEnabled = imageGeneration;
    if (includeSources !== null) input.chatbotIncludeSources = includeSources;
    if (maxImages !== null) input.chatbotMaxImagesPerRequest = maxImages;
    if (personality) {
      input.chatbotPersonalityAsset = await deps.assets.savePersonality(context.interaction.guildId!, personality);
      input.chatbotPersonalityFile = null;
    }
    if (useDefaultPersonality === true) {
      input.chatbotPersonalityAsset = null;
      input.chatbotPersonalityFile = null;
    }
    if (examples) {
      input.chatbotExamplesAsset = await deps.assets.saveExamples(context.interaction.guildId!, examples);
      input.chatbotExamplesFile = null;
    }
    if (useDefaultExamples === true) {
      input.chatbotExamplesAsset = null;
      input.chatbotExamplesFile = null;
    }
    const personaDrift = context.interaction.options.getBoolean("persona-drift");
    if (personaDrift !== null) input.chatbotPersonaDriftEnabled = personaDrift;
    if (context.interaction.options.getBoolean("reset-persona-drift") === true) {
      await deps.personaDriftStore?.reset(context.interaction.guildId!);
    }
    return { ok: true };
  },
  describe: (previous, updated) => {
    if (updated.roles.chatbot.size !== previous.roles.chatbot.size) {
      return [
        "Chatbot settings updated.",
        `Chatbot roles: ${formatRoleGroupList(updated.roles.chatbot)}`,
        roleGroupDescriptions.chatbot,
      ].join("\n");
    }
    return null;
  },
  fieldChanges: [
    { label: "Chatbot enabled", read: (p) => p.features.chatbot },
    { label: "Chatbot cooldown (seconds)", read: (p) => p.chat.cooldownSeconds },
    { label: "Chatbot denied message", read: (p) => p.chat.deniedMessage },
    { label: "Chatbot denied-message link URL", read: (p) => p.chat.deniedLinkUrl },
    { label: "Chatbot denied-message link label", read: (p) => p.chat.deniedLinkLabel },
    { label: "Chatbot web search mode", read: (p) => p.chat.webSearchMode },
    { label: "Chatbot tool calling", read: (p) => p.chat.toolCallingEnabled },
    { label: "Chatbot image input", read: (p) => p.chat.imageInputEnabled },
    { label: "Chatbot image generation", read: (p) => p.chat.imageGenerationEnabled },
    { label: "Chatbot include sources", read: (p) => p.chat.includeSources },
    { label: "Chatbot max images per request", read: (p) => p.chat.maxImagesPerRequest },
    { label: "Chatbot persona drift (experimental)", read: (p) => p.chat.personaDriftEnabled },
  ],
};
