import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bumpVersion, compareVersions, planRelease } from "../scripts/release-version.mjs";

test("release bumps default to patch and honor explicit minor/major titles", () => {
  assert.equal(bumpVersion("v1.2.9", "Fix commands (#4)"), "v1.2.10");
  assert.equal(bumpVersion("v1.2.9", "New feature [release:minor] (#5)"), "v1.3.0");
  assert.equal(bumpVersion("v1.2.9", "[release:major] [release:minor]"), "v2.0.0");
  assert.ok(compareVersions("v1.10.0", "v1.9.9") > 0);
  assert.throws(() => bumpVersion("v1.0.0-rc.1", "Fix"));
});

test("versions survive out-of-order publication and retries without moving tags", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "haf-release-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.invalid");
  const commit = (title) => {
    git("commit", "--allow-empty", "-m", title);
    return git("rev-parse", "HEAD");
  };
  commit("Initial release");
  assert.throws(() => planRelease("HEAD", cwd), /No stable release tag/);
  git("tag", "v1.0.0");
  const first = commit("Fix");
  const second = commit("Feature [release:minor]");
  const third = commit("Fix again");
  assert.equal(planRelease(third, cwd).tag, "v1.1.1");
  git("tag", "v1.1.1", third);
  assert.deepEqual(planRelease(first, cwd), { tag: "v1.0.1", previous: "v1.0.0", latest: false });
  git("tag", "v1.0.1", first);
  assert.equal(planRelease(second, cwd).tag, "v1.1.0");
  git("tag", "v1.1.0", second);
  assert.equal(planRelease(third, cwd).tag, "v1.1.1");
  assert.equal(planRelease(commit("Breaking [release:major]"), cwd).tag, "v2.0.0");
  git("checkout", "-b", "unrelated", "v1.0.0");
  commit("Different commit");
  git("tag", "v2.0.0");
  git("checkout", "main");
  assert.throws(() => planRelease("HEAD", cwd), /already belongs to another commit/);
});
