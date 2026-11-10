export const DEFAULT_COMMERCE_ACCENT_COLOR = 0x5865f2;
export const COMMERCE_BRANDING_TAGLINE_MAX_LENGTH = 160;

export interface CommerceBranding {
  guildId: string;
  connectedAccountId: string;
  accentColor: number;
  tagline: string;
  createdByUserId: string;
  updatedByUserId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceBrandingInput {
  guildId: string;
  connectedAccountId: string;
  accentColor: number;
  tagline: string;
  actorUserId: string;
  nowMs: number;
}

export interface CommerceBrandingStore {
  readByGuild(guildId: string): Promise<CommerceBranding | null>;
  save(input: CommerceBrandingInput): Promise<CommerceBranding>;
  reset(guildId: string, connectedAccountId: string): Promise<void>;
}

export interface CommercePublicBranding {
  guildName: string;
  guildIconUrl: string | null;
  accentColor: number;
  tagline: string;
}

export function validateCommerceBrandingInput(input: { accentColor: number; tagline: string }): {
  accentColor: number;
  tagline: string;
} {
  if (
    !Number.isInteger(input.accentColor) ||
    input.accentColor < 0 ||
    input.accentColor > 0xffffff
  ) {
    throw new Error("Commerce branding accent colour must be a 24-bit integer.");
  }
  const tagline = input.tagline.trim();
  if (tagline.length > COMMERCE_BRANDING_TAGLINE_MAX_LENGTH) {
    throw new Error(
      `Commerce branding tagline must be ${COMMERCE_BRANDING_TAGLINE_MAX_LENGTH} characters or fewer.`,
    );
  }
  return { accentColor: input.accentColor, tagline };
}

export function commerceAccentHex(accentColor: number): string {
  const { accentColor: validated } = validateCommerceBrandingInput({
    accentColor,
    tagline: "",
  });
  return `#${validated.toString(16).padStart(6, "0")}`;
}

export function commerceAccentForeground(accentColor: number): "#10131a" | "#ffffff" {
  const { accentColor: validated } = validateCommerceBrandingInput({
    accentColor,
    tagline: "",
  });
  const red = (validated >> 16) & 0xff;
  const green = (validated >> 8) & 0xff;
  const blue = validated & 0xff;
  const luminance =
    0.2126 * relativeChannelLuminance(red) +
    0.7152 * relativeChannelLuminance(green) +
    0.0722 * relativeChannelLuminance(blue);
  const darkContrast = (luminance + 0.05) / 0.057;
  const lightContrast = 1.05 / (luminance + 0.05);
  return darkContrast >= lightContrast ? "#10131a" : "#ffffff";
}

function relativeChannelLuminance(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function defaultCommerceBranding(guildName: string): CommercePublicBranding {
  return {
    guildName,
    guildIconUrl: null,
    accentColor: DEFAULT_COMMERCE_ACCENT_COLOR,
    tagline: "Support the server and unlock a closer community experience.",
  };
}
