import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const versionPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function compareVersions(left, right) {
  const a = left.match(versionPattern)?.slice(1).map(Number);
  const b = right.match(versionPattern)?.slice(1).map(Number);
  if (!a || !b) throw new Error("Expected stable vMAJOR.MINOR.PATCH tags.");
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function bumpVersion(version, title) {
  const parts = version.match(versionPattern)?.slice(1).map(Number);
  if (!parts) throw new Error(`Invalid release version: ${version}`);
  if (title.includes("[release:major]")) return `v${parts[0] + 1}.0.0`;
  if (title.includes("[release:minor]")) return `v${parts[0]}.${parts[1] + 1}.0`;
  return `v${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

export function planRelease(sha, cwd = process.cwd()) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const tags = git("tag", "--list")
    .split("\n")
    .filter((tag) => versionPattern.test(tag))
    .sort(compareVersions);
  // Only use first-parent ancestors: tags on merged feature branches are not releases of main.
  const ancestors = new Set(git("rev-list", "--first-parent", sha).split("\n"));
  const base = tags.findLast((tag) => ancestors.has(git("rev-list", "-n", "1", tag)));
  if (!base) throw new Error("No stable release tag exists on the first-parent history.");
  const commits = git("rev-list", "--first-parent", "--reverse", `${base}..${sha}`)
    .split("\n")
    .filter(Boolean);
  let tag = base;
  for (const commit of commits) tag = bumpVersion(tag, git("show", "-s", "--format=%s", commit));
  if (tags.includes(tag) && git("rev-list", "-n", "1", tag) !== git("rev-parse", sha)) {
    throw new Error(`Release tag ${tag} already belongs to another commit.`);
  }
  return {
    tag,
    previous: commits.length ? base : tags.findLast((item) => compareVersions(item, tag) < 0) || "",
    latest: !tags.some((item) => compareVersions(item, tag) > 0),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = planRelease(process.env.GITHUB_SHA || "HEAD");
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(plan)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  }
  console.log(JSON.stringify(plan));
}
