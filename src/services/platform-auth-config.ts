import type { SubjectIdentifierPlatform } from "../types";

export interface PlatformAuthConfig {
  platformName: SubjectIdentifierPlatform;
  displayName: string;
  iconUrl: string;
  profileUrl: (platformId: string) => string;
  buildAuthUrl: (params: { state: string; publicUrl: string }) => URL;
  verifyAssertion: (request: Request) => Promise<string | null>;
}
