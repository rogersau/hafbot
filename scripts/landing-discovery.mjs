import { JSDOM } from "jsdom";
import { validateChangelog } from "./changelog-format.mjs";

// Render the same trusted, locally built page used by the browser. No network is needed.
export function prerenderChangelog(template, javascript) {
  const dom = new JSDOM(template, { runScripts: "outside-only" });
  try {
    dom.window.eval(javascript);
    if (!dom.window.document.querySelector("#landing-root h1")) {
      throw new Error("Changelog prerender produced no heading.");
    }
    dom.window.document.querySelector('script[src="/landing/assets/changelog.js"]')?.remove();
    return dom.serialize();
  } finally {
    dom.window.close();
  }
}

export function renderChangelogFeed(changelog) {
  validateChangelog(changelog);
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

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
