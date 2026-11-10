const CHANGE_TYPES = {
  new: "New",
  improved: "Improved",
  fixed: "Fixed",
};

export function validateChangelog(changelog) {
  if (!changelog || !Array.isArray(changelog.releases) || changelog.releases.length === 0) {
    throw new Error("Changelog must contain at least one release.");
  }

  const versions = new Set();
  for (const [index, release] of changelog.releases.entries()) {
    const location = `Release ${index + 1}`;
    requireText(release?.version, `${location} must have a version.`);
    requireText(release?.title, `${location} must have a title.`);
    requireText(release?.summary, `${location} must have a summary.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(release?.date ?? "")) {
      throw new Error(`${location} must have a date in YYYY-MM-DD format.`);
    }
    const parsedDate = new Date(`${release.date}T00:00:00Z`);
    if (
      Number.isNaN(parsedDate.valueOf()) ||
      parsedDate.toISOString().slice(0, 10) !== release.date
    ) {
      throw new Error(`${location} must have a valid calendar date.`);
    }
    const previousRelease = changelog.releases[index - 1];
    if (
      previousRelease &&
      (release.date > previousRelease.date ||
        (release.date === previousRelease.date && release.version > previousRelease.version))
    ) {
      throw new Error("Changelog releases must be ordered newest first.");
    }
    if (versions.has(release.version)) {
      throw new Error(`Duplicate changelog version: ${release.version}.`);
    }
    versions.add(release.version);
    if (!Array.isArray(release.changes) || release.changes.length === 0) {
      throw new Error(`${location} must have at least one change.`);
    }
    for (const change of release.changes) {
      if (!Object.hasOwn(CHANGE_TYPES, change?.type ?? "")) {
        throw new Error(
          `${location} has an unsupported change type: ${change?.type ?? "missing"}.`,
        );
      }
      requireText(change?.text, `${location} has a change without text.`);
    }
    validateDiscordLimits(release, location);
  }
}

export function getLatestRelease(changelog) {
  validateChangelog(changelog);
  return changelog.releases[0];
}

export function buildDiscordPayload(release, changelogUrl) {
  const fields = Object.entries(CHANGE_TYPES).flatMap(([type, name]) => {
    const changes = release.changes.filter((change) => change.type === type);
    return changes.length === 0
      ? []
      : [
          {
            name,
            value: formatChangeField(changes),
          },
        ];
  });

  return {
    username: "HAF Bot updates",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: release.title,
        url: changelogUrl,
        description: release.summary,
        color: 0x667eea,
        fields,
        footer: {
          text: `HAF Bot · ${release.version} · ${formatReleaseDate(release.date)}`,
        },
      },
    ],
  };
}

export function assertGeneratedBundleFresh(bundleSource, latestVersion) {
  if (!bundleSource.includes(latestVersion)) {
    throw new Error(
      `Generated landing bundle is stale: expected changelog version ${latestVersion}. Run pnpm build:landing.`,
    );
  }
}

function validateDiscordLimits(release, location) {
  if (release.title.length > 256) {
    throw new Error(`${location} title exceeds Discord's 256 character limit.`);
  }
  if (release.summary.length > 4096) {
    throw new Error(`${location} summary exceeds Discord's 4,096 character limit.`);
  }

  const populatedFields = Object.entries(CHANGE_TYPES).flatMap(([type, name]) => {
    const changes = release.changes.filter((change) => change.type === type);
    if (changes.length === 0) return [];
    const value = formatChangeField(changes);
    if (value.length > 1024) {
      throw new Error(`${location} ${name} changes exceed Discord's 1,024 character field limit.`);
    }
    return [{ name, value }];
  });
  const footer = `HAF Bot · ${release.version} · ${formatReleaseDate(release.date)}`;
  const embedCharacters =
    release.title.length +
    release.summary.length +
    footer.length +
    populatedFields.reduce((total, field) => total + field.name.length + field.value.length, 0);
  if (embedCharacters > 6000) {
    throw new Error(`${location} exceeds Discord's 6,000 character embed limit.`);
  }
}

function formatChangeField(changes) {
  return changes.map((change) => `• ${change.text}`).join("\n");
}

function requireText(value, message) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(message);
}

function formatReleaseDate(date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}
