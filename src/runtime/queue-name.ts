export function queueNameForEnvironment(canonicalName: string, stagingMode: boolean): string {
  if (!stagingMode) return canonicalName;
  return canonicalName.replace(/^haf-bot-/, "haf-bot-staging-");
}

export function isConfiguredQueue(
  actualName: string,
  canonicalName: string,
  stagingMode: boolean,
): boolean {
  return actualName === queueNameForEnvironment(canonicalName, stagingMode);
}
