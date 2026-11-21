import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import {
  compressedSizes,
  findInlineDataUrls,
  logicalId,
  packageName,
  staticClosure,
} from "../scripts/admin-bundle/report-lib.mjs";
import { serveAdmin } from "../scripts/admin-qa/server.mjs";

test("static closure is deterministic and counts shared chunks once", () => {
  const chunks = {
    "admin.js": { imports: ["shared.js", "a.js"] },
    "a.js": { imports: ["shared.js"] },
    "shared.js": { imports: [] },
  };
  assert.deepEqual(staticClosure("admin.js", chunks), ["a.js", "admin.js", "shared.js"]);
});

test("logical bundle IDs do not depend on generated chunk names", () => {
  assert.equal(
    logicalId("src/admin/components/admin-managed-messages-page.tsx"),
    "route.managedMessages",
  );
  assert.equal(
    logicalId("src/admin/components/emoji-picker-implementation.tsx"),
    "interaction.unicodeEmojiPicker",
  );
  assert.equal(
    logicalId("src/admin/components/discord-message-preview-implementation.tsx"),
    "interaction.discordPreview",
  );
});

test("the built Start admin document uses its reported client assets and nonce", async (t) => {
  const server = await serveAdmin();
  t.after(() => server.close());
  const report = JSON.parse(await readFile("artifacts/admin-bundle-report.json", "utf8"));
  const response = await fetch(`${server.origin}/admin/docs-guild`);
  assert.equal(response.status, 200);
  const html = await response.text();
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const css = document.querySelector('link[rel="stylesheet"]')?.getAttribute("href");
  const nonce = document.querySelector('meta[property="csp-nonce"]')?.content;
  assert.ok(nonce, "Start exposes the per-request nonce");
  const inlineScripts = [...document.scripts].filter((script) => script.textContent.trim());
  assert.ok(inlineScripts.some((script) => script.textContent.includes("prefers-color-scheme")));
  for (const script of inlineScripts) assert.equal(script.nonce, nonce);
  assert.ok(report.css.some(({ file }) => `/${file}` === css));
  assert.ok(html.includes(`/${report.entry.entryFile}`));

  const [script, stylesheet] = await Promise.all([
    fetch(`${server.origin}/${report.entry.entryFile}`),
    fetch(`${server.origin}${css}`),
  ]);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get("content-type"), /text\/css/);
  assert.doesNotMatch(html + (await stylesheet.text()), /fonts\.googleapis|fonts\.gstatic/i);
  await script.body.cancel();
});

test("compression, package attribution, and inline data measurement are stable", () => {
  assert.deepEqual(compressedSizes("repeatable content"), compressedSizes("repeatable content"));
  assert.equal(packageName("node_modules/.pnpm/x/node_modules/@scope/pkg/index.js"), "@scope/pkg");
  assert.deepEqual(findInlineDataUrls("url(data:image/png;base64,AAAAAA==)"), [
    { mimeType: "image/png", decodedBytes: 4 },
  ]);
  assert.deepEqual(findInlineDataUrls("data:invalid,payload"), []);
});

test("route page modules are dynamic entries outside the initial graph", async () => {
  const report = JSON.parse(await readFile("artifacts/admin-bundle-report.json", "utf8"));
  const routePages = Object.values(report.routePageModules);

  assert.equal(routePages.length, 32);
  assert.ok(report.routes["route.reactionRoles"]);
  assert.ok(report.routes["route.wardogsCommunity"]);
  assert.ok(routePages.every((page) => page.dynamicallyImported));
  assert.ok(routePages.every((page) => !page.inInitialGraph));
  assert.ok(
    routePages.every((page) => page.moduleId.startsWith("src/admin/components/") && page.file),
  );
});

test("heavy interaction chunks are outside initial and route closures", async () => {
  const report = JSON.parse(await readFile("artifacts/admin-bundle-report.json", "utf8"));
  const interactionFiles = new Set(
    Object.values(report.interactionModules).map((interaction) => interaction.entryFile),
  );

  assert.ok(interactionFiles.size > 0);
  assert.ok(report.entry.files.every((file) => !interactionFiles.has(file)));
  assert.ok(
    Object.values(report.routes).every((route) =>
      route.files.every((file) => !interactionFiles.has(file)),
    ),
  );
});

test("large generated data URLs are externalized from interaction chunks", async () => {
  const report = JSON.parse(await readFile("artifacts/admin-bundle-report.json", "utf8"));

  assert.ok(report.assets.some(({ file }) => /inline-[a-f0-9]+\.svg$/.test(file)));
  assert.ok(report.inlineDataUrls.every(({ decodedBytes }) => decodedBytes <= 4096));
});

test("shell menus and resource search stay outside initial and route downloads", async () => {
  const report = JSON.parse(await readFile("artifacts/admin-bundle-report.json", "utf8"));
  const { chunks } = JSON.parse(
    await readFile("dist-admin/.vite/admin-bundle-metadata.json", "utf8"),
  );
  for (const moduleId of [
    "src/admin/components/admin-command-palette-view.tsx",
    "src/admin/components/admin-guild-menu.tsx",
    "src/admin/components/resource-select-command.tsx",
    "src/runtime/auth/auth-client.ts",
  ]) {
    const chunk = Object.entries(chunks).find(([, chunk]) => chunk.facadeModuleId === moduleId);
    assert.ok(chunk, `${moduleId} has its own dynamic entry`);
    const [file] = chunk;
    assert.ok(!report.entry.files.includes(file), `${moduleId} is outside initial JavaScript`);
    assert.ok(Object.values(report.routes).every((route) => !route.files.includes(file)));
    assert.ok(Object.values(chunks).some((chunk) => chunk.dynamicImports.includes(file)));
  }
});
