import type { IdentityPattern, SubjectIdentifier } from "./types";

export const DEFAULT_IDENTITY_PATTERNS: IdentityPattern[] = [
  {
    id: "seed-steam-profile-url",
    platform: "steam",
    pattern: "steamcommunity\\.com/profiles/(\\d{17})",
    captureGroup: 1,
    position: 10,
    disabled: false,
    createdAtMs: 0,
  },
  {
    id: "seed-steam-id64",
    platform: "steam",
    pattern: "\\b(7656119\\d{10})\\b",
    captureGroup: 1,
    position: 20,
    disabled: false,
    createdAtMs: 0,
  },
  {
    id: "seed-discord-mention",
    platform: "discord",
    pattern: "<@!?(\\d{17,20})>",
    captureGroup: 1,
    position: 30,
    disabled: false,
    createdAtMs: 0,
  },
  {
    id: "seed-discord-id",
    platform: "discord",
    pattern: "\\b(\\d{17,20})\\b",
    captureGroup: 1,
    position: 40,
    disabled: false,
    createdAtMs: 0,
  },
  {
    id: "seed-xbox-xuid",
    platform: "xbox",
    pattern: "\\b(\\d{16})\\b",
    captureGroup: 1,
    position: 50,
    disabled: false,
    createdAtMs: 0,
  },
  {
    id: "seed-cftools-url",
    platform: "cftools",
    pattern: "cftools\\.(?:cloud|com)/(?:profile|users?)/(?:steam/)?([A-Za-z0-9_-]+)",
    captureGroup: 1,
    position: 60,
    disabled: false,
    createdAtMs: 0,
  },
  {
    id: "seed-playstation-psnprofiles-url",
    platform: "playstation",
    pattern: "psnprofiles\\.com/([A-Za-z][A-Za-z0-9_-]{2,15})",
    captureGroup: 1,
    position: 70,
    disabled: false,
    createdAtMs: 0,
  },
  {
    id: "seed-playstation-online-id",
    platform: "playstation",
    pattern: "\\b([A-Za-z][A-Za-z0-9_-]{2,15})\\b",
    captureGroup: 1,
    position: 80,
    disabled: false,
    createdAtMs: 0,
  },
];

export function scanSourceText(
  text: string,
  links: string[],
  patterns: IdentityPattern[],
): SubjectIdentifier[] {
  const subjects: SubjectIdentifier[] = [];
  const seen = new Set<string>();
  const seenRawIds = new Set<string>();
  for (const input of [text, ...links]) {
    for (const pattern of sortedEnabledPatterns(patterns)) {
      if (isBroadPlayStationOnlineIdPattern(pattern) && !isSingleTokenInput(input)) {
        continue;
      }
      for (const subject of matchAllSubjects(input, pattern)) {
        if (seenRawIds.has(subject.id)) continue;
        const key = `${subject.platform}:${subject.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        seenRawIds.add(subject.id);
        subjects.push(subject);
      }
    }
  }
  return subjects;
}

export function parseUserInput(
  text: string,
  patterns: IdentityPattern[],
): SubjectIdentifier | null {
  for (const pattern of sortedEnabledPatterns(patterns)) {
    const subject = matchFirstSubject(text, pattern);
    if (subject) return subject;
  }
  return null;
}

export function formatSubjectsForEmbed(subjects: SubjectIdentifier[]): string {
  if (subjects.length === 0) return "none";
  return subjects
    .map((subject) =>
      subject.platform === "discord" ? `<@${subject.id}>` : `${subject.platform}:${subject.id}`,
    )
    .join(", ");
}

function sortedEnabledPatterns(patterns: IdentityPattern[]): IdentityPattern[] {
  return patterns.filter((pattern) => !pattern.disabled).sort((a, b) => a.position - b.position);
}

function isBroadPlayStationOnlineIdPattern(pattern: IdentityPattern): boolean {
  return pattern.id === "seed-playstation-online-id";
}

function isSingleTokenInput(input: string): boolean {
  const trimmed = input.trim();
  return trimmed.length > 0 && !/[\s/.]/.test(trimmed) && !trimmed.includes(":");
}

function matchAllSubjects(input: string, pattern: IdentityPattern): SubjectIdentifier[] {
  const regex = buildRegex(pattern, true);
  if (!regex) return [];
  const subjects: SubjectIdentifier[] = [];
  for (const match of input.matchAll(regex)) {
    const id = match[pattern.captureGroup]?.trim();
    if (id) subjects.push({ platform: pattern.platform, id });
  }
  return subjects;
}

function matchFirstSubject(input: string, pattern: IdentityPattern): SubjectIdentifier | null {
  if (isBroadPlayStationOnlineIdPattern(pattern) && !isSingleTokenInput(input)) return null;
  const regex = buildRegex(pattern, false);
  if (!regex) return null;
  const match = regex.exec(input);
  const id = match?.[pattern.captureGroup]?.trim();
  return id ? { platform: pattern.platform, id } : null;
}

function buildRegex(pattern: IdentityPattern, global: boolean): RegExp | null {
  try {
    return new RegExp(pattern.pattern, global ? "gi" : "i");
  } catch {
    return null;
  }
}
