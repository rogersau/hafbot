import { readFile } from "node:fs/promises";

const report = JSON.parse(await readFile("artifacts/admin-bundle-report.json", "utf8"));
const config = JSON.parse(await readFile("config/admin-bundle-budgets.json", "utf8"));
const failures = [];

function check(label, metric, actual, budget, closure) {
  if (actual <= budget) return;
  const contributors = (closure?.modules ?? [])
    .slice(0, 8)
    .map((module) => `    ${module.renderedBytes} B  ${module.id}`)
    .join("\n");
  failures.push(
    `${label} ${metric}: ${actual} B actual > ${budget} B budget (+${actual - budget} B)` +
      (closure?.files?.length ? `\n  Files:\n    ${closure.files.join("\n    ")}` : "") +
      (contributors ? `\n  Top contributors:\n${contributors}` : "") +
      "\n  Inspect artifacts/admin-bundle-report.json for import and package details.",
  );
}

check(
  "initialJs",
  "rawBytes",
  report.entry.rawBytes,
  config.budgets.initialJs.rawBytes,
  report.entry,
);
check(
  "initialJs",
  "gzipBytes",
  report.entry.gzipBytes,
  config.budgets.initialJs.gzipBytes,
  report.entry,
);
const cssGzip = report.css.reduce((sum, asset) => sum + asset.gzipBytes, 0);
check("totalInitialCss", "gzipBytes", cssGzip, config.budgets.totalInitialCss.gzipBytes);
for (const [id, budget] of Object.entries(config.budgets.routes)) {
  const closure = report.routes[id];
  if (!closure) {
    failures.push(`${id}: logical route closure was not found`);
    continue;
  }
  check(id, "gzipBytes", closure.gzipBytes, budget.gzipBytes, closure);
}
for (const id of Object.keys(report.routes)) {
  if (!config.budgets.routes[id]) failures.push(`${id}: route has no explicit gzip budget`);
}
for (const [id, page] of Object.entries(report.routePageModules ?? {})) {
  if (page.inInitialGraph) failures.push(`${id}: ${page.moduleId} is in the initial module graph`);
  if (!page.dynamicallyImported)
    failures.push(`${id}: ${page.moduleId} is not dynamically imported`);
}
for (const [id, budget] of Object.entries(config.budgets.interactions)) {
  const closure = report.interactionModules[id];
  if (!closure) failures.push(`${id}: logical interaction chunk was not found`);
  else check(id, "gzipBytes", closure.gzipBytes, budget.gzipBytes, closure);
}
for (const asset of report.assets.filter(({ file }) => file.endsWith(".js"))) {
  check(
    `singleAsset ${asset.file}`,
    "rawBytes",
    asset.rawBytes,
    config.budgets.singleAsset.rawBytes,
  );
}
for (const dataUrl of report.inlineDataUrls) {
  check(
    `inlineDataUrl ${dataUrl.file} (${dataUrl.mimeType})`,
    "decodedBytes",
    dataUrl.decodedBytes,
    config.budgets.inlineDataUrl.decodedBytes,
  );
}

if (failures.length) {
  console.error(
    `Admin bundle budget failed:\n\n${failures.join("\n\n")}\n\nInspect artifacts/admin-bundle-report.md`,
  );
  process.exitCode = 1;
} else {
  console.log("Admin bundle budgets passed.");
}
