import type changelogData from "../../changelog.json";

export const CHANGELOG_FEED_LINK = {
  rel: "alternate",
  type: "application/atom+xml",
  title: "HAF Bot updates",
  href: "https://hafbot.xyz/changelog.xml",
};

export function renderChangelogFeed(changelog: typeof changelogData) {
  const origin = "https://hafbot.xyz";
  const entries = changelog.releases.map((release) => {
    const id = `${origin}/changelog#release-${encodeURIComponent(release.version)}`;
    const text = release.changes.map((change) => `${change.type}: ${change.text}`).join("\n");
    return `<entry>
<id>${xml(id)}</id>
<title>${xml(release.title)}</title>
<link href="${xml(id)}"/>
<updated>${release.date}T00:00:00Z</updated>
<published>${release.date}T00:00:00Z</published>
<summary>${xml(release.summary)}</summary>
<content type="text">${xml(text)}</content>
</entry>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-AU">
<id>${origin}/changelog.xml</id>
<title>HAF Bot updates</title>
<subtitle>Release notes for HAF Bot. Entries describe behaviour at their release date; see current documentation for availability.</subtitle>
<link href="${origin}/changelog.xml" rel="self" type="application/atom+xml"/>
<link href="${origin}/changelog" rel="alternate" type="text/html"/>
<author><name>HAF Bot</name></author>
<updated>${changelog.releases[0].date}T00:00:00Z</updated>
${entries.join("\n")}
</feed>\n`;
}

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
