import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";

const image = process.argv[2];
const e2e = process.argv[3] === "--e2e";
if (!image || process.argv.length > 4 || (process.argv[3] !== undefined && !e2e))
  throw new Error("Usage: node scripts/container-smoke.mjs <image> [--e2e]");
const databaseName = e2e ? "haf_smoke_e2e_test" : "haf_smoke";

const migrationNames = (await readdir(new URL("../migrations/postgres/", import.meta.url)))
  .filter((name) => name.endsWith(".sql"))
  .sort();
if (migrationNames.length === 0) throw new Error("No PostgreSQL migrations found for smoke test.");

const suffix = `${process.pid}`;
const appContainer = `haf-container-smoke-app-${suffix}`;
const databaseContainer = `haf-container-smoke-postgres-${suffix}`;
const network = `haf-container-smoke-${suffix}`;
const postgresImage =
  "postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685";

try {
  runDocker(["network", "create", network]);
  runDocker([
    "run",
    "--detach",
    "--rm",
    "--name",
    databaseContainer,
    "--network",
    network,
    "--network-alias",
    "postgres",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
    "--env",
    `POSTGRES_DB=${databaseName}`,
    "--env",
    "POSTGRES_USER=haf",
    "--env",
    "POSTGRES_PASSWORD=haf_smoke_only",
    postgresImage,
  ]);
  await waitForPostgres(20_000);

  runDocker([
    "run",
    "--detach",
    "--rm",
    "--name",
    appContainer,
    "--network",
    network,
    "--read-only",
    "--tmpfs",
    "/tmp:size=64m,mode=1777",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--publish",
    "127.0.0.1::8080",
    "--env",
    `DATABASE_URL=postgresql://haf:haf_smoke_only@postgres:5432/${databaseName}`,
    "--env",
    "NODE_ENV=test",
    "--env",
    "STAGING_MODE=true",
    "--env",
    "HAF_RUN_MIGRATIONS=true",
    "--env",
    "HAF_GATEWAY_ENABLED=false",
    "--env",
    "HAF_JOBS_ENABLED=false",
    "--env",
    "HAF_SCHEDULER_ENABLED=false",
    "--env",
    "HAF_ALLOW_OBJECT_STORAGE_DISABLED=true",
    "--env",
    "HAF_STATUS_TOKEN=container-smoke-status",
    "--env",
    `DISCORD_PUBLIC_KEY=${"a".repeat(64)}`,
    "--env",
    "DISCORD_BOT_TOKEN=container-smoke-token",
    "--env",
    "BOT_USER_ID=123456789012345678",
    ...(e2e
      ? [
          "--env",
          "HAF_E2E_GUILD_ID=323456789012345678",
          "--env",
          "HAF_E2E_BOT_USER_IDS=223456789012345678",
        ]
      : []),
    image,
  ]);
  const portOutput = runDocker(["port", appContainer, "8080/tcp"]).trim();
  const port = Number(portOutput.slice(portOutput.lastIndexOf(":") + 1));
  if (!Number.isSafeInteger(port) || port < 1) {
    throw new Error("Docker did not publish a valid port.");
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  const ready = await fetchUntil(`${baseUrl}/health/ready`, 200, 30_000);
  const readyBody = await ready.json();
  if (readyBody.status !== "ready" || readyBody.checks?.runtime !== true) {
    throw new Error(`Container readiness payload was invalid: ${JSON.stringify(readyBody)}`);
  }
  const live = await fetch(`${baseUrl}/health/live`);
  if (live.status !== 200) throw new Error(`Container liveness returned ${live.status}.`);
  const status = await fetch(`${baseUrl}/internal/status`, {
    headers: { authorization: "Bearer container-smoke-status" },
  });
  if (status.status !== 200) throw new Error(`Container status returned ${status.status}.`);
  const statusBody = await status.json();
  if (statusBody.runtime?.discordE2eGuildId !== (e2e ? "323456789012345678" : undefined)) {
    throw new Error("Container runtime did not install the requested E2E guild scope.");
  }
  if (
    statusBody.runtime?.migrationRuntime !== "postgres" ||
    statusBody.runtime?.migrations !== migrationNames.length ||
    JSON.stringify(statusBody.runtime?.migrationNames) !== JSON.stringify(migrationNames)
  ) {
    throw new Error(
      `Container migration status was invalid: ${JSON.stringify(statusBody.runtime)}`,
    );
  }
  const application = await fetch(`${baseUrl}/not-a-real-route`);
  if (application.status !== 404) {
    throw new Error(`Container application route returned ${application.status}.`);
  }

  const security = runDocker([
    "inspect",
    appContainer,
    "--format",
    "{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.SecurityOpt}}",
  ]).trim();
  if (!security.startsWith("node|true|") || !security.includes("no-new-privileges:true")) {
    throw new Error(`Container security settings were not applied: ${security}`);
  }
  const runtimeSurface = JSON.parse(
    runDocker([
      "exec",
      appContainer,
      "node",
      "--input-type=module",
      "--eval",
      [
        'import { existsSync, readdirSync } from "node:fs";',
        'const packages = readdirSync("/app/node_modules/.pnpm");',
        'const buildToolPrefixes = ["@esbuild+", "drizzle-kit@", "vite@", "vitest@", "wrangler@"];',
        "console.log(JSON.stringify({",
        '  e2eEntrypoint: existsSync("/app/dist-e2e/main.mjs"),',
        "  packageManagers: [",
        '    "/usr/local/lib/node_modules/npm",',
        '    "/usr/local/lib/node_modules/corepack",',
        '    "/opt/yarn-v1.22.22",',
        "  ].filter(existsSync),",
        "  buildTools: packages.filter((name) => buildToolPrefixes.some((prefix) => name.startsWith(prefix))),",
        "}));",
      ].join("\n"),
    ]).trim(),
  );
  if (runtimeSurface.packageManagers.length > 0 || runtimeSurface.buildTools.length > 0) {
    throw new Error(
      `Container includes unnecessary runtime tooling: ${JSON.stringify(runtimeSurface)}`,
    );
  }
  if (runtimeSurface.e2eEntrypoint !== e2e) {
    throw new Error("Container E2E entrypoint does not match the requested image variant.");
  }
  console.info("Container smoke test passed with PostgreSQL migrations and full readiness.");
} catch (error) {
  const logs = dockerOutput(["logs", "--tail", "100", appContainer]);
  if (logs) console.error(`Application container logs:\n${logs}`);
  throw error;
} finally {
  spawnSync("docker", ["stop", "--time", "5", appContainer], { stdio: "ignore" });
  spawnSync("docker", ["stop", "--time", "2", databaseContainer], { stdio: "ignore" });
  spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
}

async function waitForPostgres(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawnSync(
      "docker",
      ["exec", databaseContainer, "pg_isready", "-U", "haf", "-d", databaseName],
      { encoding: "utf8" },
    );
    if (result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("PostgreSQL smoke container did not become ready before the deadline.");
}

async function fetchUntil(url, expectedStatus, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status === expectedStatus) return response;
      lastError = new Error(`Received HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Container did not return HTTP ${expectedStatus} before the deadline.`, {
    cause: lastError,
  });
}

function runDocker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function dockerOutput(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return result.status === 0 ? (result.stdout || result.stderr).trim() : "";
}
