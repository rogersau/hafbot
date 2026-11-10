import assert from "node:assert/strict";
import test from "node:test";
import { createAdminApiHandler } from "./helpers/admin-api";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";
import { createCloudflareWardogsStore } from "../src/runtime/cloudflare-wardogs-store";
import { WardogsService } from "../src/wardogs/service";
import { createWebhookCredentialKeyRing } from "../src/security/webhook-credentials";

test("WARDOGS admin dispatch enforces Guild read/write access and never exposes saved passwords", async () => {
  const fixture = createProductionRuntimeStores();
  const authorization: { mode: string; guildId?: string | null }[] = [];
  try {
    const service = new WardogsService({
      store: createCloudflareWardogsStore(fixture.database.d1),
      runtime: "cloudflare",
      keyRing: () => createWebhookCredentialKeyRing({ keyV1: btoa("k".repeat(32)) }),
      transport: async () => {
        assert.fail("disabled setup cannot reach network");
      },
    });
    const handler = createAdminApiHandler({
      stores: fixture.stores,
      discordBotToken: "test",
      wardogs: service,
      adminAccess: {
        async authorize(request, requirement) {
          authorization.push(requirement);
          return request.headers.get("x-test-authorized") === "yes" &&
            requirement.guildId === "guild-1"
            ? { ok: true }
            : { ok: false, error: { _tag: "Forbidden", message: "Forbidden" } };
        },
      },
    });
    async function request(path: string, body?: unknown, allowed = true) {
      const url = new URL(`https://admin.example.com/admin/api/wardogs${path}`);
      const req = new Request(url, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          "x-test-authorized": allowed ? "yes" : "no",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const response = await handler(req, url);
      assert.ok(response);
      return response;
    }
    assert.equal((await request("?guildId=guild-1", undefined, false)).status, 403);
    assert.equal(
      (await request("/targets", { guildId: "guild-2", name: "Wrong", originRef: null })).status,
      403,
    );
    const created = await request("/targets", {
      guildId: "guild-1",
      name: "Preparation",
      originRef: null,
    });
    assert.equal(created.status, 200);
    const { target } = (await created.json()) as { target: { id: string; generation: number } };
    const replaced = await request("/change", {
      guildId: "guild-1",
      targetId: target.id,
      generation: target.generation,
      secret: "test-password",
    });
    assert.equal(replaced.status, 200);
    const text = await replaced.text();
    for (const secret of ["test-password", "envelope", "fingerprint", "ciphertext", "credentialId"])
      assert.ok(!text.includes(secret));
    assert.equal(
      (
        await request("/test", {
          guildId: "guild-1",
          targetId: target.id,
          generation: 2,
          roster: false,
        })
      ).status,
      409,
    );
    const state = await request("?guildId=guild-1");
    assert.equal(state.status, 200);
    assert.ok(authorization.some((entry) => entry.mode === "read"));
    assert.ok(authorization.some((entry) => entry.mode === "write"));
    assert.equal(
      (
        await request("/change", {
          guildId: "guild-1",
          targetId: target.id,
          generation: 2,
          origin: "http://127.0.0.1",
        })
      ).status,
      400,
    );
  } finally {
    fixture.close();
  }
});

test("WARDOGS readiness stays feature-owned and does not require a Discord permission lookup", async () => {
  const fixture = createProductionRuntimeStores();
  try {
    const service = new WardogsService({
      store: createCloudflareWardogsStore(fixture.database.d1),
      runtime: "cloudflare",
    });
    const handler = createAdminApiHandler({
      stores: fixture.stores,
      discordBotToken: "unused",
      wardogs: service,
      adminAccess: {
        async authorize(_request, requirement) {
          assert.equal(requirement.guildId, "guild-1");
          return { ok: true };
        },
      },
    });
    const url = new URL(
      "https://admin.example.com/admin/api/permissions?guildId=guild-1&feature=wardogs",
    );
    const response = await handler(new Request(url), url);
    assert.ok(response);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      guildId: "guild-1",
      feature: "wardogs",
      checks: [
        {
          id: "wardogs-read-approval",
          label: "WARDOGS read readiness",
          status: "warning",
          detail:
            "Read access requires an encrypted password, both network switches, operator approval of this generation and a successful read test. Writes remain unavailable.",
          remediation: "Open WARDOGS targets to configure or test read access.",
        },
      ],
    });
  } finally {
    fixture.close();
  }
});
