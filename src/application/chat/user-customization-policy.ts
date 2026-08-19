export const userCustomizationLimits = {
  maxChars: 2_000,
} as const;

export type UserCustomizationValidationResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

export function validateUserCustomization(input: string): UserCustomizationValidationResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: "Customization cannot be empty." };
  if (trimmed.length > userCustomizationLimits.maxChars) {
    return { ok: false, reason: `Customization must be ${userCustomizationLimits.maxChars} characters or fewer.` };
  }
  return { ok: true, value: trimmed };
}
