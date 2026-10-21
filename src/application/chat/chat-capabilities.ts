export interface ChatCapabilitySettings {
  webSearchMode: "off" | "auto";
  toolsEnabled?: boolean;
  imageInputEnabled?: boolean;
  imageGenerationEnabled: boolean;
}
export interface ChatCapabilityScope {
  guarded: boolean;
  nativeWebSearchSupported: boolean;
  shadow?: boolean;
  groundedRecovery?: boolean;
  blocked?: boolean;
}

// Shared by execution and operator status. An enabled setting alone is not
// authority to enable an unmigrated source or an unsupported transport.
export function effectiveChatCapabilities(settings: ChatCapabilitySettings, scope: ChatCapabilityScope): {
  webSearchMode: "off" | "auto"; toolsEnabled: boolean; imageInputEnabled: boolean; imageGenerationEnabled: boolean;
} {
  const external = !scope.blocked && !scope.shadow && !scope.groundedRecovery;
  const migrated = external && !scope.guarded;
  return {
    webSearchMode: external && scope.nativeWebSearchSupported ? settings.webSearchMode : "off",
    toolsEnabled: migrated && settings.toolsEnabled === true,
    imageInputEnabled: !scope.blocked && !scope.guarded && settings.imageInputEnabled === true,
    imageGenerationEnabled: migrated && settings.imageGenerationEnabled,
  };
}
