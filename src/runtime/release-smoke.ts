import type { Env } from "../env";

export function workerVersionId(env: Env): string {
  return env.WORKER_VERSION?.id ?? "development";
}

export async function handleReleaseSystemRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/health")
    return new Response("OK", {
      headers: { "cache-control": "no-store", "x-haf-worker-version": workerVersionId(env) },
    });
  if (url.pathname !== "/internal/release/smoke") return null;
  if (!env.RELEASE_SMOKE_SECRET) return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const timestamp = request.headers.get("x-haf-release-timestamp") ?? "";
  const signature = request.headers.get("x-haf-release-signature") ?? "";
  const seconds = Number(timestamp);
  const rawBody = await request.text();
  if (
    !Number.isFinite(seconds) ||
    Math.abs(Date.now() / 1000 - seconds) > 60 ||
    !(await validSignature(env.RELEASE_SMOKE_SECRET, `${timestamp}.${rawBody}`, signature))
  ) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  let expectedVersionId: string;
  try {
    expectedVersionId = JSON.parse(rawBody).expectedVersionId;
  } catch {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  const checks: Array<{ name: string; ok: boolean; durationMs: number; error?: string }> = [];
  const run = async (name: string, operation: () => Promise<boolean> | boolean) => {
    const start = Date.now();
    let ok = false;
    try {
      ok = await operation();
    } catch (error) {
      ok = false;
      checks.push({
        name,
        ok,
        durationMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    checks.push({ name, ok, durationMs: Date.now() - start });
  };
  const versionId = workerVersionId(env);
  await run("worker-version", () => versionId === expectedVersionId);
  await run("haf-db-read", async () => {
    if (!env.HAF_DB) return false;
    await env.HAF_DB.prepare("SELECT plan FROM guild_entitlements LIMIT 1").first<{
      plan: string;
    }>();
    return true;
  });
  await run("haf-auth-read", async () => {
    if (!env.HAF_DB) return false;
    await env.HAF_DB.prepare("SELECT id FROM session LIMIT 1").first<{ id: string }>();
    return true;
  });
  const ok = checks.every((check) => check.ok);
  return Response.json(
    { ok, versionId, checks },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}

async function validSignature(secret: string, message: string, provided: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  const actual = Uint8Array.from(provided.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++)
    difference |= expected[index] ^ actual[index];
  return difference === 0;
}
