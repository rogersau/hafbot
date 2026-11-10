import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

import { commonResponses, scenarios } from "./scenarios.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const assetRoot = resolve(root, "dist-admin");
const artifactRoot = resolve(root, ".artifacts/admin-docs");
const mode = process.argv.includes("--check") ? "check" : "update";
const scenarioArgument = process.argv.find((argument) => argument.startsWith("--scenario="));
const scenarioName = scenarioArgument?.slice("--scenario=".length);
const selectedScenarios = scenarioName
  ? scenarios.filter((scenario) => scenario.name === scenarioName)
  : scenarios;
if (scenarioName && selectedScenarios.length === 0) {
  throw new Error(`Unknown Admin documentation scenario: ${scenarioName}`);
}
const server = createServer(handleRequest);

await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});

const address = server.address();
if (!address || typeof address === "string")
  throw new Error("Unable to determine capture server port");
const baseUrl = `http://127.0.0.1:${address.port}`;

let browser;
try {
  browser = await chromium.launch();
  const failures = [];

  for (const scenario of selectedScenarios) {
    const output = scenario.output ?? `docs-site/public/images/generated/${scenario.name}.png`;
    const actualPath =
      mode === "check" ? resolve(artifactRoot, `${scenario.name}.png`) : resolve(root, output);
    await mkdir(dirname(actualPath), { recursive: true });

    const context = await browser.newContext({
      viewport: scenario.viewport ?? { width: 1440, height: 1050 },
      colorScheme: "dark",
      locale: "en-AU",
      timezoneId: "Australia/Sydney",
      deviceScaleFactor: 1,
    });
    await context.addCookies([{ name: "theme", value: "dark", url: baseUrl }]);
    await context.route("**/admin/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const fixture = scenario.responses[pathname] ?? commonResponses[pathname];
      const response =
        typeof fixture === "function" ? fixture(new URL(route.request().url())) : fixture;
      if (response === undefined) {
        failures.push(`${scenario.name}: no fixture for ${pathname}`);
        await route.fulfill({
          status: 501,
          json: { error: `No documentation fixture for ${pathname}` },
        });
        return;
      }
      await route.fulfill({ status: 200, json: response });
    });

    const page = await context.newPage();
    page.on("pageerror", (error) => failures.push(`${scenario.name}: ${error.message}`));
    await page.goto(`${baseUrl}${scenario.route}`, { waitUntil: "networkidle" });
    try {
      await page.getByRole("heading", { name: scenario.heading, exact: true }).first().waitFor();
    } catch (error) {
      const diagnostics = failures.filter((failure) => failure.startsWith(`${scenario.name}:`));
      const bodyText = (await page.locator("body").innerText()).slice(0, 1_000);
      throw new Error(
        `${scenario.name}: expected heading "${scenario.heading}" was not rendered${
          diagnostics.length > 0 ? `\n${diagnostics.join("\n")}` : ""
        }\nURL: ${page.url()}\nBody: ${bodyText}`,
        { cause: error },
      );
    }
    if (scenario.openCommandPalette) {
      await page.locator('[data-command-palette-trigger="true"]').click();
      await page.locator('[data-command-palette="true"]').waitFor();
    }
    if (scenario.openContextSwitcher) {
      await page.locator("#sidebar-guild").click();
      await page.locator("#admin-guild-menu").waitFor();
    }
    if (scenario.openMobileNavigation) {
      await page.getByRole("button", { name: "Open navigation menu" }).click();
      await page.getByRole("dialog", { name: "Admin navigation" }).waitFor();
    }
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation-duration: 0s !important;
          caret-color: transparent !important;
          transition-duration: 0s !important;
        }
      `,
    });
    await page.evaluate(() => document.fonts.ready);
    if (scenario.focusTargetText) {
      await page
        .getByText(scenario.focusTargetText, { exact: true })
        .first()
        .scrollIntoViewIfNeeded();
    }
    await addAnnotations(page, scenario.annotations ?? []);
    await page
      .locator(scenario.locator ?? ".admin-shell-root")
      .screenshot({ path: actualPath, animations: "disabled" });
    await context.close();

    if (mode === "check") {
      const expectedPath = resolve(root, output);
      let matches = false;
      try {
        const [expected, actual] = await Promise.all([
          readFile(expectedPath),
          readFile(actualPath),
        ]);
        const expectedPng = PNG.sync.read(expected);
        const actualPng = PNG.sync.read(actual);
        if (expectedPng.width === actualPng.width && expectedPng.height === actualPng.height) {
          const diff = new PNG({ width: expectedPng.width, height: expectedPng.height });
          const differingPixels = pixelmatch(
            expectedPng.data,
            actualPng.data,
            diff.data,
            expectedPng.width,
            expectedPng.height,
            { threshold: 0.2 },
          );
          const differingRatio = differingPixels / (expectedPng.width * expectedPng.height);
          matches = differingRatio <= (scenario.maxDiffPixelRatio ?? 0.001);
          if (!matches) {
            await writeFile(
              resolve(artifactRoot, `${scenario.name}.diff.png`),
              PNG.sync.write(diff),
            );
            failures.push(
              `${scenario.name}: ${(differingRatio * 100).toFixed(3)}% of pixels differ`,
            );
          }
        }
      } catch {
        matches = false;
      }
      if (!matches) {
        failures.push(
          `${scenario.name}: screenshot is stale; compare ${actualPath} and run pnpm docs:screenshots`,
        );
      }
    }
  }

  if (failures.length > 0) throw new Error(failures.join("\n"));
  process.stdout.write(
    `Admin documentation screenshots ${mode === "check" ? "match" : "updated"}.\n`,
  );
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function addAnnotations(page, annotations) {
  if (annotations.length === 0) return;

  const positioned = [];
  for (const item of annotations) {
    const target = item.selector
      ? page.locator(item.selector).first()
      : page.getByText(item.targetText, { exact: item.exact ?? true }).first();
    await target.waitFor({ state: "visible", timeout: 5_000 });
    const rect = await target.boundingBox();
    if (!rect) {
      throw new Error(
        `Documentation annotation target has no bounding box: ${item.selector ?? item.targetText}`,
      );
    }
    positioned.push({ ...item, rect });
  }

  await page.evaluate((items) => {
    const layer = document.createElement("div");
    layer.setAttribute("data-docs-annotations", "true");
    layer.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:Oxanium,sans-serif";

    for (const item of items) {
      const marker = document.createElement("div");
      marker.setAttribute("aria-label", `${item.number}. ${item.label}`);
      marker.title = item.label;
      marker.textContent = String(item.number);
      marker.style.cssText = [
        "position:fixed",
        `left:${Math.max(4, item.rect.x - 34)}px`,
        `top:${Math.max(4, item.rect.y - 10)}px`,
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "width:28px",
        "height:28px",
        "border:2px solid #ffffff",
        "border-radius:9999px",
        "background:#657cff",
        "color:#ffffff",
        "box-shadow:0 2px 10px rgba(0,0,0,.65)",
        "font-size:14px",
        "font-weight:800",
        "line-height:1",
      ].join(";");
      layer.append(marker);
    }

    document.body.append(layer);
  }, positioned);
}

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (
    url.pathname.startsWith("/admin/assets/") ||
    url.pathname === "/favicon.ico" ||
    url.pathname === "/logo.png"
  ) {
    const relativePath = url.pathname.replace(/^\//, "");
    const filePath = resolve(assetRoot, relativePath);
    if (!filePath.startsWith(`${assetRoot}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      response.writeHead(200, { "content-type": contentType(filePath) });
      response.end(await readFile(filePath));
    } catch {
      response.writeHead(404).end();
    }
    return;
  }

  if (url.pathname.startsWith("/admin")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderShell(url.pathname, url.search));
    return;
  }

  response.writeHead(404).end();
}

function renderShell(pathname, search) {
  return `<!doctype html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>HAF Bot documentation capture</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Oxanium:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/assets/admin.css" />
</head>
<body>
  <div id="admin-root"
    data-authenticated="true"
    data-initial-path="${escapeAttribute(pathname)}"
    data-initial-search="${escapeAttribute(search)}"
    data-user-name="Alex Morgan"
    data-user-email="alex@example.invalid"></div>
  <script type="module" src="/admin/assets/admin.js"></script>
</body>
</html>`;
}

function escapeAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function contentType(filePath) {
  if (extname(filePath) === ".js") return "text/javascript; charset=utf-8";
  if (extname(filePath) === ".css") return "text/css; charset=utf-8";
  if (extname(filePath) === ".png") return "image/png";
  if (extname(filePath) === ".ico") return "image/x-icon";
  return "application/octet-stream";
}
