export function parseAppIdList(value: string): number[] {
  return value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter(
      (appId, index, appIds) =>
        Number.isInteger(appId) && appId > 0 && appIds.indexOf(appId) === index,
    );
}

export function parseAppIdListWithErrors(value: string): { appIds: number[]; invalid: string[] } {
  const appIds: number[] = [];
  const invalid: string[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isInteger(parsed) && parsed > 0 && !appIds.includes(parsed)) {
      appIds.push(parsed);
    } else {
      invalid.push(trimmed);
    }
  }
  return { appIds, invalid };
}
