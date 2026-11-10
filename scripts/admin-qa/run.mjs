import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "./api.mjs";
import { scenarios } from "./scenarios.mjs";
import { exitCode, selectScenarios, summarize } from "./report.mjs";
import { serveAdmin } from "./server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const value = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const artifactRoot = resolve(root, value("--output") ?? ".artifacts/admin-qa");
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  boundary:
    "Compiled Admin SPA with fictional API state. Does not verify live Discord, backend authorization, billing, OAuth, or provider delivery.",
  source: {},
  runtime: { node: process.version, platform: process.platform },
  build: { status: "not-run" },
  cases: scenarios.map(({ id, title, tier, role }) => ({
    id,
    title,
    tier,
    role,
    status: "not-run",
    reason: "Not selected",
  })),
};
let selected;
let browser;
let server;
try {
  for (const arg of args) {
    if (
      !["--list", "--prebuilt"].includes(arg) &&
      !["--scenario=", "--output=", "--browser-executable="].some((prefix) =>
        arg.startsWith(prefix),
      )
    )
      throw new Error(`Unknown argument: ${arg}`);
  }
  selected = selectScenarios(scenarios, value("--scenario"));
  if (args.includes("--list")) {
    process.stdout.write(
      `${JSON.stringify(
        scenarios.map(({ run: _run, ...scenario }) => scenario),
        null,
        2,
      )}\n`,
    );
  } else {
    await mkdir(artifactRoot, { recursive: true });
    try {
      report.source.commit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      report.source.commit = null;
    }
    if (process.env.HAF_QA_SOURCE_REVISION)
      report.source.declaredRevision = process.env.HAF_QA_SOURCE_REVISION;
    for (const scenario of selected)
      Object.assign(
        report.cases.find((item) => item.id === scenario.id),
        { status: "blocked", reason: "Setup did not complete" },
      );
    if (args.includes("--prebuilt")) {
      report.build = {
        status: "not-run",
        reason: "Explicit --prebuilt; caller must ensure dist-admin matches source",
      };
    } else {
      const build = await runBuild();
      await writeFile(resolve(artifactRoot, "build.log"), build.output);
      report.build = {
        status: build.code === 0 ? "pass" : "fail",
        exitCode: build.code,
        log: "build.log",
      };
      if (build.code !== 0) throw new Error("Admin build failed; see build.log");
    }
    await access(resolve(root, "dist-admin/admin/assets/admin.js"));
    await access(resolve(root, "dist-admin/admin/assets/admin.css"));
    const { chromium, expect } = await import("@playwright/test");
    report.runtime.playwright = JSON.parse(
      await readFile(resolve(root, "node_modules/@playwright/test/package.json"), "utf8"),
    ).version;
    const executablePath = value("--browser-executable");
    report.runtime.browserMode = executablePath
      ? "explicit non-pinned executable"
      : "Playwright managed Chromium";
    if (executablePath) report.runtime.executablePath = executablePath;
    browser = await chromium.launch(executablePath ? { executablePath } : {});
    report.runtime.chromium = browser.version();
    server = await serveAdmin(resolve(root, "dist-admin"));
    for (const scenario of selected) {
      const result = report.cases.find((item) => item.id === scenario.id);
      delete result.reason;
      const started = Date.now();
      const api = createApi({ tier: scenario.tier, role: scenario.role, ...scenario.apiOptions });
      let context;
      let page;
      const errors = [];
      try {
        context = await browser.newContext({
          viewport: { width: 1440, height: 1050 },
          locale: "en-AU",
          timezoneId: "Australia/Sydney",
          colorScheme: "dark",
          serviceWorkers: "block",
        });
        await context.tracing.start({ screenshots: true, snapshots: true });
        await context.route("**/*", async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== server.origin) {
            errors.push(
              `Unexpected external request: ${request.method()} ${url.origin}${url.pathname}`,
            );
            await route.abort("blockedbyclient");
          } else if (url.pathname.startsWith("/admin/api/")) {
            try {
              const response = await api.handle({
                method: request.method(),
                url: request.url(),
                body: request.postData() ? request.postDataJSON() : undefined,
              });
              await route.fulfill(response);
            } catch (error) {
              errors.push(`Fixture error: ${error.message}`);
              await route.fulfill({ status: 500, json: { error: "QA fixture error" } });
            }
          } else {
            await route.continue();
          }
        });
        await context.routeWebSocket("**/*", (socket) => {
          errors.push(`Unexpected WebSocket: ${socket.url()}`);
          socket.close();
        });
        page = await context.newPage();
        page.setDefaultTimeout(7000);
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.origin}${scenario.route}`, { waitUntil: "networkidle" });
        result.evidence = await scenario.run({ page, api, origin: server.origin, expect });
        api.assertNoUnhandled();
        api.assertExpectedFailuresConsumed();
        if (errors.length) throw new Error(errors.join("\n"));
        result.status = "pass";
      } catch (error) {
        result.status = "fail";
        result.error = error.stack ?? String(error);
        result.diagnostics = errors;
        const screenshot = `${scenario.id}.png`;
        try {
          if (page) {
            await page.screenshot({ path: resolve(artifactRoot, screenshot), fullPage: true });
            result.screenshot = screenshot;
          }
        } catch {
          /* Preserve the original failure. */
        }
      } finally {
        result.durationMs = Date.now() - started;
        result.requests = api.requests;
        result.unhandled = api.unhandled;
        if (context) {
          const trace = `${scenario.id}.trace.zip`;
          try {
            await context.tracing.stop(
              result.status === "fail" ? { path: resolve(artifactRoot, trace) } : {},
            );
            if (result.status === "fail") result.trace = trace;
          } catch (error) {
            result.artifactError = error.message;
          }
          await context.close();
        }
        process.stdout.write(`${result.status.toUpperCase()} ${scenario.id}\n`);
      }
    }
  }
} catch (error) {
  report.setupError = error.stack ?? String(error);
  if (!selected) report.cases.push({ id: "selection", status: "fail", error: error.message });
  for (const result of report.cases) if (result.status === "blocked") result.reason = error.message;
  process.stderr.write(`${error.message}\n`);
} finally {
  await browser?.close();
  await server?.close();
  if (!args.includes("--list") || report.setupError) {
    report.finishedAt = new Date().toISOString();
    report.summary = summarize(report.cases);
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(resolve(artifactRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify(report.summary)}\nReport: ${resolve(artifactRoot, "report.json")}\n`,
    );
    process.exitCode = exitCode(report.cases);
  }
}

function runBuild() {
  return new Promise((done) => {
    const child = spawn(
      process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      ["run", "build:admin"],
      { cwd: root, env: process.env },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => done({ code: 1, output: `${output}\n${error.message}` }));
    child.on("close", (code) => done({ code, output }));
  });
}
