export interface CommerceEnablementEnvironment {
  COMMERCE_ENABLED?: unknown;
}

export function isCommerceFeatureEnabled(env: CommerceEnablementEnvironment): boolean {
  return env.COMMERCE_ENABLED === "true";
}
