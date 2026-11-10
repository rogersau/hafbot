import assert from "node:assert/strict";
import test from "node:test";
import { BanAppealService, type BanAppealDiscord } from "../src/moderation-appeals/service";
import {
  BanAppealError,
  defaultBanAppealConfig,
  type BanAppeal,
  type BanAppealOperation,
  type BanAppealStore,
} from "../src/moderation-appeals/types";
import {
  createBanAppealAdminRoutes,
  createBanAppealPublicRoutes,
} from "../src/moderation-appeals/routes";
import { dispatchAdminRoute } from "../src/runtime/admin-route-registry";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import { DiscordApiError } from "../src/discord/client";

const appealId = "07db2e13-e7dc-43a0-8082-b214022d2a12";
const session = { user: { id: "account", discordUserId: "101", name: "Appellant" } };
const makeAppeal = (): BanAppeal => ({
  id: appealId,
  guildId: "100",
  userId: "101",
  displayName: "Appellant",
  text: "Please review the Discord server ban.",
  banReason: "Private ban evidence",
  status: "pending",
  revision: 1,
  createdAtMs: 1_000,
  resolvedAtMs: null,
  reviewerUserId: null,
  decisionReason: "Private staff note",
  operationId: null,
});

function fixture() {
  let appeal = makeAppeal();
  let banned = true;
  let now = 1_000;
  let failUnban: Error | null = null;
  let effectBeforeFailure = false;
  let denied = false;
  let submitted = 0;
  let claims = 0;
  let unbans = 0;
  let actor = "";
  const operations: BanAppealOperation[] = [];
  const config = { ...defaultBanAppealConfig("100"), enabled: true, revision: 1 };
  const store: BanAppealStore = {
    getConfig: async () => config,
    saveConfig: async (_guildId, settings, revision) => {
      if (revision !== config.revision) throw new BanAppealError("Changed", 409);
      Object.assign(config, settings, { revision: revision + 1 });
      return config;
    },
    latestForUser: async () => appeal,
    nextSubmissionAt: async () => 0,
    list: async () => [appeal],
    read: async (guildId, id) => (guildId === "100" && id === appealId ? appeal : null),
    operations: async () => operations,
    submit: async (input) => {
      submitted += 1;
      appeal = { ...makeAppeal(), userId: input.userId, text: input.text };
      return appeal;
    },
    claimReview: async (input) => {
      claims += 1;
      actor = input.actorUserId;
      if (appeal.status === "unbanned" || appeal.status === "rejected")
        return { appeal, operation: null, execute: false };
      if (appeal.status === "unban_pending" && input.action === "unban")
        return { appeal, operation: operations[operations.length - 1]!, execute: false };
      if (appeal.revision !== input.expectedRevision) throw new BanAppealError("Changed", 409);
      if (input.action === "reject") {
        appeal = { ...appeal, status: "rejected", revision: appeal.revision + 1 };
        return { appeal, operation: null, execute: false };
      }
      const operation: BanAppealOperation = {
        id: input.operationId,
        appealId,
        actorUserId: input.actorUserId,
        reason: input.reason,
        outcome: "started",
        createdAtMs: now,
        completedAtMs: null,
      };
      operations.push(operation);
      appeal = {
        ...appeal,
        operationId: operation.id,
        status: "unban_pending",
        revision: appeal.revision + 1,
      };
      return { appeal, operation, execute: true };
    },
    finishUnban: async (_guildId, _appealId, operationId, outcome) => {
      const operation = operations.find((entry) => entry.id === operationId)!;
      operation.outcome = outcome;
      operation.completedAtMs = now;
      appeal = {
        ...appeal,
        revision: appeal.revision + 1,
        status:
          outcome === "succeeded" ? "unbanned" : outcome === "failed" ? "pending" : "unban_pending",
      };
      return appeal;
    },
  };
  const discord: BanAppealDiscord = {
    readBan: async () => (banned ? { reason: "Private ban evidence" } : null),
    assertCapabilities: async () => {},
    assertCanReview: async () => {
      if (denied) throw new BanAppealError("Missing Ban Members", 403);
    },
    unban: async () => {
      unbans += 1;
      if (failUnban) {
        if (effectBeforeFailure) banned = false;
        throw failUnban;
      }
      banned = false;
    },
  };
  return {
    service: new BanAppealService(store, "100", discord, () => now),
    discord,
    store,
    config,
    operations,
    get appeal() {
      return appeal;
    },
    get claims() {
      return claims;
    },
    get unbans() {
      return unbans;
    },
    get submitted() {
      return submitted;
    },
    get actor() {
      return actor;
    },
    setBan: (value: boolean) => {
      banned = value;
    },
    setDenied: () => {
      denied = true;
    },
    advance: () => {
      now += 120_000;
    },
    fail: (error: Error | null, effect = false) => {
      failUnban = error;
      effectBeforeFailure = effect;
    },
  };
}
const decision = (revision = 1) => ({
  id: appealId,
  actorUserId: "303",
  action: "unban" as const,
  reason: "Appeal reviewed and approved",
  expectedRevision: revision,
});

test("Ban appeals expose only the signed-in appellant's public fields and verify a current ban before submission", async () => {
  const h = fixture();
  const state = await h.service.publicState(session.user);
  assert.equal(state.currentBan, true);
  assert.doesNotMatch(
    JSON.stringify(state),
    /Private ban evidence|Private staff note|reviewerUserId|userId/,
  );
  h.setBan(false);
  await assert.rejects(
    () =>
      h.service.submit(session.user, {
        id: appealId,
        text: "Please review the Discord server ban.",
      }),
    /not currently banned/,
  );
  assert.equal(h.submitted, 0);
});

test("Ban appeal decisions require fresh staff permissions before claiming any operation", async () => {
  const h = fixture();
  h.setDenied();
  await assert.rejects(() => h.service.review(decision()), /Missing Ban Members/);
  assert.equal(h.claims, 0);
  assert.equal(h.unbans, 0);
});

test("An ambiguous successful unban is reconciled under its original operation and never removes a later re-ban", async () => {
  const h = fixture();
  h.fail(new Error("Response interrupted"), true);
  await assert.rejects(() => h.service.review(decision()), /could not be confirmed/);
  const originalOperation = h.appeal.operationId;
  assert.equal(h.appeal.status, "unban_pending");
  assert.equal(h.unbans, 1);
  const reconciled = await h.service.review(decision(h.appeal.revision));
  assert.equal(reconciled.status, "unbanned");
  assert.equal(reconciled.operationId, originalOperation);
  h.setBan(true);
  h.fail(null);
  await h.service.review(decision(h.appeal.revision));
  assert.equal(h.unbans, 1);
  assert.equal(h.operations.length, 1);
});

test("An uncertain unban with a remaining ban cannot replay DELETE and can be explicitly rejected", async () => {
  const h = fixture();
  h.fail(new Error("Network unavailable"));
  await assert.rejects(() => h.service.review(decision()), /could not be confirmed/);
  await assert.rejects(() => h.service.review(decision(h.appeal.revision)), /will not repeat/);
  assert.equal(h.unbans, 1);
  const result = await h.service.review({
    ...decision(h.appeal.revision),
    action: "reject",
    reason: "Ban remains appropriate after staff review",
  });
  assert.equal(result.status, "rejected");
  assert.equal(h.operations[0]?.outcome, "uncertain");
});

test("Confirmed Discord rejections preserve attempt history and permit a new explicit action", async () => {
  const h = fixture();
  h.fail(new DiscordApiError("Forbidden", 403, ""));
  await assert.rejects(() => h.service.review(decision()), /Discord refused/);
  assert.equal(h.appeal.status, "pending");
  assert.equal(h.operations[0]?.outcome, "failed");
  h.fail(null);
  assert.equal((await h.service.review(decision(h.appeal.revision))).status, "unbanned");
  assert.equal(h.operations.length, 2);
  assert.equal(h.unbans, 2);
});

test("HTTP timeouts stay uncertain and service suspensions prevent submission or review effects", async () => {
  const h = fixture();
  h.fail(new DiscordApiError("Request timeout", 408, ""));
  await assert.rejects(() => h.service.review(decision()), /could not be confirmed/);
  assert.equal(h.appeal.status, "unban_pending");
  assert.equal(h.operations[0]?.outcome, "uncertain");
  const suspended = new BanAppealService(
    h.store,
    "100",
    h.discord,
    () => 1_000,
    async () => true,
  );
  await assert.rejects(
    () =>
      suspended.submit(session.user, {
        id: appealId,
        text: "Please review this Discord server ban.",
      }),
    /Service unavailable/,
  );
  await assert.rejects(() => suspended.review(decision(h.appeal.revision)), /Service unavailable/);
  assert.equal(h.submitted, 0);
  assert.equal(h.unbans, 1);
});

test("Public ban appeals use same-origin JSON, bounded bodies and OAuth session identities", async () => {
  const h = fixture();
  let authenticated = true;
  const routes = createBanAppealPublicRoutes({
    serviceForGuild: async () => h.service,
    readCustomerSession: async () => (authenticated ? session : null),
    publicBaseUrl: "https://example.com",
    now: () => 1_000,
  });
  const request = (body: unknown, origin = "https://example.com") =>
    new Request("https://example.com/api/ban-appeals/100", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await routes(
        request(
          { id: appealId, text: "Please review the Discord server ban." },
          "https://attacker.example",
        ),
      )
    )?.status,
    403,
  );
  authenticated = false;
  assert.equal(
    (await routes(request({ id: appealId, text: "Please review the Discord server ban." })))
      ?.status,
    401,
  );
  authenticated = true;
  assert.equal(
    (
      await routes(
        request({ id: appealId, text: "Please review the Discord server ban.", userId: "999" }),
      )
    )?.status,
    400,
  );
  assert.equal((await routes(request({ id: appealId, text: "x".repeat(20_000) })))?.status, 413);
  const accepted = await routes(
    request({ id: appealId, text: "Please review the Discord server ban." }),
  );
  assert.equal(accepted?.status, 200);
  assert.equal(h.appeal.userId, session.user.discordUserId);
  assert.doesNotMatch(await accepted!.text(), /101|Private/);
  const page = await routes(new Request("https://example.com/ban-appeals/100"));
  assert.match(page!.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.match(page!.headers.get("cache-control") ?? "", /no-store/);
  assert.doesNotMatch(await page!.text(), /Private ban evidence|Private staff note/);
  authenticated = false;
  h.config.title = 'Review <img src=x onerror="alert(1)">';
  const anonymous = await routes(new Request("https://example.com/ban-appeals/100"));
  const anonymousHtml = await anonymous!.text();
  assert.match(anonymousHtml, /Sign in with Discord/);
  assert.match(anonymousHtml, /&lt;img/);
  assert.doesNotMatch(anonymousHtml, /<img src=x/);
  const script = await routes(new Request("https://example.com/assets/ban-appeals.js"));
  assert.match(await script!.text(), /sign-in\/social'.*method:'POST'/);
});

test("Ban appeal admin routes preserve Guild authorization and derive reviewer identity from the session", async () => {
  const h = fixture();
  let reads = 0;
  const routes = createBanAppealAdminRoutes({
    serviceForGuild: async () => {
      reads += 1;
      return h.service;
    },
    readCustomerSession: async () => ({ user: { ...session.user, discordUserId: "303" } }),
  });
  const requirements: unknown[] = [];
  const denied = {
    authorize: async (_request: Request, requirement: unknown) => {
      requirements.push(requirement);
      return { ok: false as const, error: { _tag: "Forbidden" as const, message: "Denied" } };
    },
  };
  const read = await dispatchAdminRoute(
    routes,
    new Request("https://example.com/admin/api/ban-appeals?guildId=100&workspaceId=workspace-a"),
    { adminAccess: denied, features: ALL_FEATURES_ENABLED, stores: {} as never },
  );
  assert.equal(read?.status, 403);
  assert.equal(reads, 0);
  assert.deepEqual(requirements, [{ mode: "read", guildId: "100", workspaceId: "workspace-a" }]);
  const accepted = await dispatchAdminRoute(
    routes,
    new Request("https://example.com/admin/api/ban-appeals/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "100",
        workspaceId: "workspace-a",
        appealId,
        action: "reject",
        reason: "Review completed",
        expectedRevision: 1,
        actorUserId: "999",
      }),
    }),
    {
      adminAccess: { authorize: async () => ({ ok: true }) },
      features: ALL_FEATURES_ENABLED,
      stores: {} as never,
    },
  );
  assert.equal(accepted?.status, 200);
  assert.equal(h.actor, "303");
});
