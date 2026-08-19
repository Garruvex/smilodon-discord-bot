import { ChannelType } from "discord.js";

import {
  formatRoleGroupList,
  roleGroupDescriptions,
} from "../../../../../application/access/role-group-descriptions.js";
import type { MutationSettingDefinition } from "./setting-definition.js";

export const chatbotSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "chatbot",
  description: "Configures mention-based AI replies.",
  configureOptions: (b) => b
    .addBooleanOption((o) => o.setName("enabled").setDescription("Reply when permitted users mention the bot."))
    .addRoleOption((o) => o.setName("role").setDescription("Adds a role allowed to use mention chat."))
    .addChannelOption((o) => o.setName("channel").setDescription("Adds a text channel where mention chat is allowed.").addChannelTypes(ChannelType.GuildText))
    .addIntegerOption((o) => o.setName("cooldown-seconds").setDescription("Per-user delay between requests.").setMinValue(0).setMaxValue(86400))
    .addStringOption((o) => o.setName("denied-message").setDescription("Playful response shown to users without access.").setMaxLength(500))
    .addStringOption((o) => o.setName("denied-link-url").setDescription("Optional link button URL shown with the denied message. Use \"none\" to remove it."))
    .addStringOption((o) => o.setName("denied-link-label").setDescription("Label for the denied-message link button.").setMaxLength(80))
    .addBooleanOption((o) => o.setName("web-search").setDescription("Allow the model to search the public web when needed."))
    .addBooleanOption((o) => o.setName("image-input").setDescription("Allow bounded image attachments from Discord."))
    .addBooleanOption((o) => o.setName("image-generation").setDescription("Allow the model to generate images in mention chat."))
    .addBooleanOption((o) => o.setName("include-sources").setDescription("Include web citation links in replies."))
    .addIntegerOption((o) => o.setName("max-images").setDescription("Maximum images accepted per request.").setMinValue(0).setMaxValue(4))
    .addAttachmentOption((o) => o.setName("personality").setDescription("Upload the guild personality as a Markdown file."))
    .addBooleanOption((o) => o.setName("use-default-personality").setDescription("Remove the uploaded personality and use the built-in/default file.")),
  handle: async (context, deps, previousProfile, input) => {
    const enabled = context.interaction.options.getBoolean("enabled");
    const role = context.interaction.options.getRole("role");
    const channel = context.interaction.options.getChannel("channel");
    const cooldown = context.interaction.options.getInteger("cooldown-seconds");
    const deniedMessage = context.interaction.options.getString("denied-message");
    const deniedLinkUrl = context.interaction.options.getString("denied-link-url");
    const deniedLinkLabel = context.interaction.options.getString("denied-link-label");
    const webSearch = context.interaction.options.getBoolean("web-search");
    const imageInput = context.interaction.options.getBoolean("image-input");
    const imageGeneration = context.interaction.options.getBoolean("image-generation");
    const includeSources = context.interaction.options.getBoolean("include-sources");
    const maxImages = context.interaction.options.getInteger("max-images");
    const personality = context.interaction.options.getAttachment("personality");
    const useDefaultPersonality = context.interaction.options.getBoolean("use-default-personality");
    if (personality && useDefaultPersonality === true) {
      return { ok: false, message: "Choose either a personality upload or the default personality, not both." };
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
    { label: "Chatbot image input", read: (p) => p.chat.imageInputEnabled },
    { label: "Chatbot image generation", read: (p) => p.chat.imageGenerationEnabled },
    { label: "Chatbot include sources", read: (p) => p.chat.includeSources },
    { label: "Chatbot max images per request", read: (p) => p.chat.maxImagesPerRequest },
  ],
};
