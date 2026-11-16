import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const TEST_FILE_PATTERN = /\.test\.(?:ts|tsx|mjs)$/;

export function getTestInventory(cwd = process.cwd()) {
  const files = trackedTestFiles(cwd);
  const assignments = new Map();
  const unassigned = [];

  for (const file of files) {
    const suite = classifyTest(file);
    if (!suite) {
      unassigned.push(file);
      continue;
    }
    const assigned = assignments.get(file) ?? [];
    assigned.push(suite);
    assignments.set(file, assigned);
  }

  const duplicateAssignments = [...assignments.entries()]
    .filter(([, suites]) => suites.length !== 1)
    .map(([file, suites]) => ({ file, suites }));

  return {
    files,
    node: files.filter((file) => classifyTest(file) === "node"),
    browser: files.filter((file) => classifyTest(file) === "node" && isBrowserTest(file, cwd)),
    unit: files.filter((file) => classifyTest(file) === "node" && nodeSuite(file) === "unit"),
    integration: files.filter(
      (file) => classifyTest(file) === "node" && nodeSuite(file) === "integration",
    ),
    build: files.filter((file) => classifyTest(file) === "build"),
    architecture: files.filter((file) => classifyTest(file) === "architecture"),
    unassigned,
    duplicateAssignments,
  };
}

export function listNodeTestPaths({
  cwd = process.cwd(),
  compiled = true,
  compiledRoot = "dist-tests",
  suite = "all",
} = {}) {
  const inventory = getTestInventory(cwd);
  let files =
    suite === "unit"
      ? inventory.unit
      : suite === "integration"
        ? inventory.integration
        : inventory.node;
  if (process.env.TEST_SKIP_BROWSER_CHECKS === "true") {
    const browserTests = new Set(inventory.browser);
    files = files.filter((file) => !browserTests.has(file));
  }
  return files
    .map((file) => {
      if (compiled && /\.test\.(?:ts|tsx)$/.test(file)) {
        return join(compiledRoot, file.replace(/\.(?:ts|tsx)$/, ".js"));
      }
      return file;
    })
    .sort();
}

function isBrowserTest(file, cwd) {
  return isPlaywrightTestSource(readFileSync(join(cwd, file), "utf8"));
}

export function isPlaywrightTestSource(source) {
  return /^\s*import\s+(?:[^"'\n]+\s+from\s+)?["'](?:@playwright\/test|playwright)["']/m.test(
    source,
  );
}

export function listBuildTestPaths(cwd = process.cwd()) {
  return getTestInventory(cwd).build.sort();
}

export function listArchitectureTestPaths({
  cwd = process.cwd(),
  compiledRoot = "dist-tests",
} = {}) {
  return getTestInventory(cwd)
    .architecture.map((file) => join(compiledRoot, file.replace(/\.(?:ts|tsx)$/, ".js")))
    .sort();
}

function classifyTest(file) {
  if (
    [
      `test${sep}admin-bundle-report.test.mjs`,
      `test${sep}admin-ux-regressions.test.mjs`,
      `test${sep}discord-e2e-entrypoints.test.mjs`,
    ].includes(file)
  )
    return "build";
  if (
    file.startsWith(`test${sep}`) &&
    [
      "service-persistence-architecture.test.ts",
      "entitlement-writer-architecture.test.ts",
      "html-response-architecture.test.ts",
      "tenant-delete-architecture.test.ts",
      "persistence-runtime-ddl-architecture.test.ts",
      "native-runtime-architecture.test.ts",
    ].includes(file.slice(`test${sep}`.length))
  ) {
    return "architecture";
  }
  if (
    (file.startsWith(`test${sep}`) || file.startsWith(`scripts${sep}`)) &&
    TEST_FILE_PATTERN.test(file)
  ) {
    return "node";
  }
  return undefined;
}

const INTEGRATION_TESTS = new Set([
  "test/community-feed-transport.test.ts",
  "test/admin-reputation-page.test.tsx",
  "test/admin-community-tools-page.test.tsx",
  "test/admin-api-community-tools.test.ts",
  "test/admin-ban-appeals-panel.test.tsx",
  "test/admin-event-recurrence-controls.test.tsx",
  "test/reaction-roles.test.ts",
  "test/reaction-roles-runtime.test.ts",
  "test/admin-reaction-roles-page.test.tsx",
  "test/admin-api-bot-defense.test.ts",
  "test/admin-api-cache.test.ts",
  "test/admin-api-entitlement.test.ts",
  "test/admin-api-evidence-vault.test.ts",
  "test/admin-api-guild-audit-log.test.ts",
  "test/admin-api-image-rules.test.ts",
  "test/admin-api-managed-messages.test.ts",
  "test/admin-api-mention-protection.test.ts",
  "test/admin-api-player-count.test.ts",
  "test/admin-api-profile.test.ts",
  "test/admin-auth-routes.test.ts",
  "test/admin-routes.test.ts",
  "test/billing-checkout.test.ts",
  "test/billing-delivery.test.ts",
  "test/billing-grace.test.ts",
  "test/billing-history.test.ts",
  "test/billing-owner-sync.test.ts",
  "test/billing-sync-queue.test.ts",
  "test/cloudflare-context.test.ts",
  "test/cloudflare-guild-entitlement-store.test.ts",
  "test/cloudflare-guild-rbac-store.test.ts",
  "test/cloudflare-player-count-store.test.ts",
  "test/cloudflare-platform-link-store.test.ts",
  "test/cloudflare-timed-role-rbac-store.test.ts",
  "test/cloudflare-user-preferences-store.test.ts",
  "test/cloudflare-webhook-proxy-store.test.ts",
  "test/gateway-bot-orchestration.test.ts",
  "test/gateway-event-dispatcher.test.ts",
  "test/gateway-protocol.test.ts",
  "test/queue-delivery.test.ts",
  "test/runtime-app.test.ts",
  "test/evidence-vault-image-route.test.ts",
  "test/global-admin-guild-suspensions.test.ts",
  "test/guild-service-policy.test.ts",
  "test/interaction-routes.test.ts",
  "test/landing-build.test.ts",
  "test/landing-public-routes.test.ts",
  "test/public-discovery.test.ts",
  "test/managed-media.test.ts",
  "test/transcript-public-routes.test.ts",
  "test/webhook-proxy-delivery-queue-consumer.test.ts",
]);

function nodeSuite(file) {
  return INTEGRATION_TESTS.has(file) ? "integration" : "unit";
}

function trackedTestFiles(cwd) {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .filter((file) => TEST_FILE_PATTERN.test(file))
      .filter((file) => existsSync(join(cwd, file)))
      .map((file) => file.split("/").join(sep))
      .sort();
  } catch {
    return walk(cwd).sort();
  }
}

function walk(root, directory = root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist-tests") {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(root, path));
    } else if (TEST_FILE_PATTERN.test(entry.name)) {
      files.push(relative(root, path));
    }
  }
  return files;
}

export function assertTestInventory(cwd = process.cwd()) {
  const inventory = getTestInventory(cwd);
  const missing = inventory.files.filter((file) => {
    if (inventory.unassigned.includes(file)) return true;
    return !existsSync(join(cwd, file));
  });
  if (inventory.unassigned.length || inventory.duplicateAssignments.length || missing.length) {
    throw new Error(
      [
        inventory.unassigned.length ? `Unassigned tests: ${inventory.unassigned.join(", ")}` : "",
        inventory.duplicateAssignments.length
          ? `Duplicate test assignments: ${inventory.duplicateAssignments
              .map(({ file, suites }) => `${file} (${suites.join(", ")})`)
              .join(", ")}`
          : "",
        missing.length ? `Missing test files: ${missing.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return inventory;
}
