import assert from "node:assert/strict";
import test from "node:test";
import type { Env } from "../src/env";
import { createPublicRoutes } from "../src/routes/public-routes";
import { createRuntimeApp } from "../src/runtime/app";
import { createCloudflareContext } from "../src/runtime/cloudflare-context";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import { readSelfHostedSite } from "../src/runtime/self-hosted-site";
import { SqliteD1Database } from "./support/sqlite-d1-database";

const environment = {
  HAF_DEPLOYMENT_MODE: "self-hosted",
  BETTER_AUTH_URL: "https://independent.example",
  SELF_HOSTED_OPERATOR_NAME: "Community Operators",
};

test("hosted remains the default and ignores unused independent-operator settings", () => {
  for (const mode of [undefined, "hosted"]) {
    assert.equal(
      readSelfHostedSite({ HAF_DEPLOYMENT_MODE: mode, SELF_HOSTED_TERMS_URL: "invalid" }),
      undefined,
    );
  }
  assert.throws(
    () => readSelfHostedSite({ HAF_DEPLOYMENT_MODE: "unknown" }),
    /HAF_DEPLOYMENT_MODE/,
  );
});

test("self-hosted links validate HTTPS, credentials, policy loops and bounded operator names", () => {
  for (const value of [
    "javascript:alert(1)",
    "http://policies.example/privacy",
    "https://user:private-value@policies.example/privacy",
    "invalid",
  ]) {
    for (const setting of [
      "SELF_HOSTED_TERMS_URL",
      "SELF_HOSTED_PRIVACY_URL",
      "SELF_HOSTED_SUPPORT_URL",
    ]) {
      assert.throws(
        () => readSelfHostedSite({ ...environment, [setting]: value }),
        (error: Error) => {
          assert.match(error.message, /HTTPS URL without credentials/);
          assert.doesNotMatch(error.message, /private-value/);
          return true;
        },
      );
    }
  }
  for (const policy of ["/terms", "/privacy", "/privacy/?a=1"]) {
    assert.throws(
      () =>
        readSelfHostedSite({
          ...environment,
          SELF_HOSTED_TERMS_URL: environment.BETTER_AUTH_URL + policy,
        }),
      /must not redirect/,
    );
  }
  for (const name of ["x".repeat(121), "community\noperators"]) {
    assert.throws(
      () => readSelfHostedSite({ ...environment, SELF_HOSTED_OPERATOR_NAME: name }),
      /SELF_HOSTED_OPERATOR_NAME/,
    );
  }
  assert.equal(
    readSelfHostedSite({ ...environment, BETTER_AUTH_URL: "http://localhost:8080" })?.publicUrl,
    "http://localhost:8080",
  );
});

test("independent home and release routes avoid the hosted catalogue and dashboard", async () => {
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    selfHostedSite: readSelfHostedSite(environment),
    landingPriceCatalog: { read: async () => assert.fail("Hosted pricing must not be read") },
  });
  for (const method of ["GET", "HEAD"]) {
    const response = await routes(new Request("https://unexpected-host.example/", { method }));
    assert.equal(response?.status, 302);
    assert.equal(response?.headers.get("location"), "https://independent.example/admin");
    assert.equal(response?.headers.get("cache-control"), "no-store");
  }
  assert.equal(
    (await routes(new Request("https://independent.example/changelog")))?.headers.get("location"),
    "https://github.com/rogersau/hafbot/releases",
  );
});

test("independent policies redirect to operator documents and never accept posted bodies", async () => {
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    selfHostedSite: readSelfHostedSite({
      ...environment,
      SELF_HOSTED_TERMS_URL: "https://policies.example/community-terms",
      SELF_HOSTED_PRIVACY_URL: "https://policies.example/community-privacy",
    }),
  });
  for (const policy of ["terms", "privacy"]) {
    const response = await routes(new Request("https://independent.example/" + policy));
    assert.equal(response?.status, 302);
    assert.equal(response?.headers.get("location"), "https://policies.example/community-" + policy);
    const posted = await routes(
      new Request("https://independent.example/" + policy, { method: "POST" }),
    );
    assert.equal(posted?.status, 405);
    assert.equal(posted?.headers.get("allow"), "GET, HEAD");
  }
});

test("missing policies identify the independent operator, escape text and retain HTML protections", async () => {
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    selfHostedSite: readSelfHostedSite({
      ...environment,
      SELF_HOSTED_OPERATOR_NAME: '<script>alert("operator")</script>',
      SELF_HOSTED_SUPPORT_URL: "https://support.example/ask?a=1&b=2",
    }),
  });
  for (const policy of ["terms", "privacy"]) {
    const response = await routes(new Request("https://independent.example/" + policy));
    assert.equal(response?.status, 503);
    assert.ok(response?.headers.get("content-security-policy"));
    assert.equal(response?.headers.get("x-frame-options"), "DENY");
    const html = await response!.text();
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>|discord\.gg|https:\/\/hafbot\.xyz/);
    assert.match(html, /https:\/\/independent\.example\/(?:terms|privacy)/);
    assert.match(html, /support\.example\/ask\?a=1&amp;b=2/);
  }
});

test("Microsoft domain verification identifies only a configured independent application", async () => {
  for (const applicationId of [undefined, "own-microsoft-app"]) {
    const routes = createPublicRoutes({
      features: ALL_FEATURES_ENABLED,
      selfHostedSite: readSelfHostedSite(environment),
      microsoftApplicationId: applicationId,
    });
    const response = await routes(
      new Request("https://independent.example/.well-known/microsoft-identity-association.json"),
    );
    assert.equal(response?.status, applicationId ? 200 : 404);
    if (applicationId)
      assert.deepEqual(await response!.json(), { associatedApplications: [{ applicationId }] });
  }
});

test("runtime context carries independent identity through the public and verified interaction routes", async () => {
  const database = new SqliteD1Database();
  try {
    const context = createCloudflareContext({
      ...environment,
      HAF_DB: database.d1,
      STAGING_MODE: "true",
      DISCORD_BOT_TOKEN: "test-token",
      BOT_USER_ID: "123456789012345678",
      DISCORD_PUBLIC_KEY: "a".repeat(64),
      SELF_HOSTED_SUPPORT_URL: "https://support.example/community",
    } as Env);
    let signatureChecks = 0;
    const app = createRuntimeApp({
      ...context,
      verifyDiscordRequest: async () => {
        signatureChecks++;
        return true;
      },
    });
    assert.equal(
      (await app.fetch(new Request("https://independent.example/"))).headers.get("location"),
      "https://independent.example/admin",
    );
    const response = await app.fetch(
      new Request("https://independent.example/interactions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature-ed25519": "test-signature",
          "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
        },
        body: JSON.stringify({
          type: 2,
          id: "interaction",
          guild_id: "guild",
          data: { name: "help" },
        }),
      }),
    );
    const result = (await response.json()) as {
      type: number;
      data: { flags: number; content: string };
    };
    assert.equal(signatureChecks, 1);
    assert.equal(result.type, 4);
    assert.equal(result.data.flags, 64);
    assert.match(result.data.content, /https:\/\/independent\.example\/admin/);
    assert.match(result.data.content, /https:\/\/support\.example\/community/);
    assert.doesNotMatch(result.data.content, /https:\/\/hafbot\.xyz|plan limits|free Player/);
  } finally {
    database.close();
  }
});
