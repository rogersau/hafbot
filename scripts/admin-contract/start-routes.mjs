import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";

import { format } from "oxfmt";

const { printWidth } = JSON.parse(
  readFileSync(new URL("../../.oxfmtrc.json", import.meta.url), "utf8"),
);
const ADMIN_API_PATH = "/admin/api";

export async function syncAdminStartRoutes({
  webDirectory,
  operations,
  billingOperations,
  contracts,
  check,
}) {
  const byOperationId = new Map(
    [...operations, ...billingOperations].map((operation) => [operation.operationId, operation]),
  );
  if (byOperationId.size !== operations.length + billingOperations.length) {
    throw new Error("Duplicate Admin server route operation ID.");
  }
  for (const contract of contracts) {
    const operation = byOperationId.get(contract.operationId);
    if (operation?.path !== contract.path || operation?.method !== contract.method) {
      throw new Error(`Admin server route does not match contract: ${contract.operationId}`);
    }
  }

  const routes = new Map();
  for (const operation of [...operations, ...billingOperations]) {
    if (
      !/^\/admin\/api\/(?:[A-Za-z0-9-]+|:[A-Za-z][A-Za-z0-9]*)(?:\/(?:[A-Za-z0-9-]+|:[A-Za-z][A-Za-z0-9]*))*$/.test(
        operation.path,
      )
    ) {
      throw new Error(`Unsupported Admin server route path: ${operation.path}`);
    }
    const path = operation.path.replaceAll(":", "$");
    const methods = routes.get(path) ?? new Map();
    if (methods.has(operation.method)) {
      throw new Error(`Duplicate Admin server route: ${operation.method} ${operation.path}`);
    }
    methods.set(operation.method, operation.operationId);
    routes.set(path, methods);
  }
  const billingPaths = new Set(billingOperations.map(({ path }) => path));
  const webRouteDirectory = join(webDirectory, "routes");
  const expected = new Set();
  const files = [
    ...[...routes].map(([path, methods]) => [path, path, methods, billingPaths.has(path)]),
    [`${ADMIN_API_PATH}/$`, `${ADMIN_API_PATH}/$`, new Map(), false],
    [`${ADMIN_API_PATH}/index`, `${ADMIN_API_PATH}/`, new Map(), false],
  ];
  for (const [file, path, methods, billing] of files) {
    const filename = join(webRouteDirectory, `${file.slice(1)}.ts`);
    expected.add(filename);
    const source = await generateRoute(file, path, methods, billing);
    const current = existsSync(filename) ? readFileSync(filename, "utf8") : null;
    if (current === source) continue;
    if (check) failDrift(filename);
    if (current !== null && !(await isGeneratedRoute(file, current))) {
      throw new Error(`Admin server route conflicts with an existing file: ${filename}`);
    }
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename, source);
  }

  const directory = join(webRouteDirectory, ADMIN_API_PATH);
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const filename = join(entry.parentPath, entry.name);
    if (expected.has(filename)) continue;
    const file = "/" + relative(webRouteDirectory, filename).split(sep).join("/").slice(0, -3);
    if (!(await isGeneratedRoute(file, readFileSync(filename, "utf8")))) {
      throw new Error(`Unexpected file in generated Admin route directory: ${filename}`);
    }
    if (check) failDrift(filename);
    unlinkSync(filename);
  }
}

async function isGeneratedRoute(file, source) {
  const path = file.endsWith("/index") ? file.slice(0, -5) : file;
  const methods = new Map();
  for (const match of source.matchAll(
    /(\w+):\s*handle(?:Admin|Billing)Operation\(\s*"([^"]+)"[,]?\s*\)/g,
  )) {
    methods.set(match[1], match[2]);
  }
  return (
    source ===
    (await generateRoute(file, path, methods, source.includes("handleBillingOperation(")))
  );
}

async function generateRoute(file, path, methods, billing) {
  const module = posix.relative(posix.dirname(`/routes${file}`), "/admin-api");
  const operationHandler = billing ? "handleBillingOperation" : "handleAdminOperation";
  const fallback = "handleUnknownAdminApiRequest";
  const imports = methods.size > 0 ? [operationHandler, fallback] : [fallback];
  const methodHandlers = [...methods.entries()].sort().map(([method, operationId]) => {
    const handler = `${operationHandler}(${JSON.stringify(operationId)})`;
    return `      ${method}: ${handler},\n`;
  });
  const routePath = JSON.stringify(path);
  const headFallback = methods.has("GET") ? `      HEAD: ${fallback},\n` : "";
  const source = `import { createFileRoute } from "@tanstack/react-router";
import { ${imports.join(", ")} } from "${module}";

export const Route = createFileRoute(${routePath})({
  server: {
    handlers: {
${methodHandlers.join("")}${headFallback}      ANY: ${fallback},
    },
  },
});
`;
  const result = await format("route.ts", source, { printWidth });
  if (result.errors.length) throw new Error(`Failed to format Admin server route ${file}.`);
  return result.code;
}

function failDrift(filename) {
  throw new Error(
    `Admin server routes have drifted at ${filename}. Run \`pnpm admin-contract:generate\`.`,
  );
}
