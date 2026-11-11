import { adminErrorResponse } from "./support/admin-error-response";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { JSDOM } from "jsdom";

import type { OperationalIncidentView } from "../src/operations/incidents";
import { ToastProvider } from "../src/admin/components/toast";

import {
  AdminOverviewPage,
  getOverviewAttentionItems,
  getStorageWarning,
} from "../src/admin/components/admin-overview-page";
import type { AdminGuildOverviewCard, RecommendedNextStep } from "../src/runtime/admin-types";
import type { EntitlementInfo } from "../src/admin/hooks/use-entitlement";

const cards: AdminGuildOverviewCard[] = [
  {
    id: "reaction-rules",
    label: "Reaction Rules",
    path: "/admin/blocklist",
    status: "configured",
    detail: "2 blocked emoji",
    locked: false,
    readiness: "enabled",
  },
  {
    id: "tickets",
    label: "Tickets",
    path: "/admin/tickets",
    status: "configured",
    detail: "Setup needs attention",
    locked: false,
    readiness: "needs_attention",
  },
  {
    id: "lfg",
    label: "LFG",
    path: "/admin/lfg",
    status: "not-set-up",
    detail: null,
    locked: false,
    readiness: "not_setup",
  },
  {
    id: "events",
    label: "Events",
    path: "/admin/events",
    status: "requires-paid-plan",
    detail: null,
    locked: true,
  },
];

const recommendation: RecommendedNextStep = {
  featureId: "mention-protection",
  title: "Set up Mention Protection",
  description: "Protect administrators and members from unwanted mention abuse.",
  ctaHref: "/admin/guild-1/mention-protection",
};

function renderPage(props: {
  selectedWorkspaceId?: string;
  selectedGuildId?: string;
  tier?: "free" | "premium" | "premium_plus" | null;
  cards?: AdminGuildOverviewCard[];
  r2Usage?: EntitlementInfo["r2Usage"] | null;
  recommendedNextStep?: RecommendedNextStep | null;
}) {
  return renderToString(
    <AdminOverviewPage
      selectedWorkspaceId={props.selectedWorkspaceId ?? ""}
      selectedGuildId={props.selectedGuildId ?? "guild-1"}
      tier={props.tier ?? null}
      cards={props.cards ?? [cards[0]!]}
      r2Usage={props.r2Usage ?? null}
      recommendedNextStep={props.recommendedNextStep ?? null}
    />,
  );
}

test("AdminOverviewPage renders All features alongside the attention queue", () => {
  const html = renderPage({ tier: "premium", cards });

  assert.match(html, /What needs your attention/);
  assert.match(html, /Tickets/);
  assert.match(html, /Setup needs attention/);
  assert.match(html, /href="\/admin\/guild-1\/tickets\?tab=panel"/);
  assert.match(html, /All features/);
  assert.match(html, /data-section="all-features"/);
  assert.match(html, /Reaction Rules/);
  assert.match(html, /2 blocked emoji/);
  assert.match(html, />LFG</);
  assert.match(html, />Events</);
  assert.match(html, />Configured</);
  assert.match(html, />Not set up</);
  assert.match(html, />Paid plan</);
  assert.doesNotMatch(html, /Premium or Premium Plus unlocks Events/);
});

test("an unavailable feature directory stays honest and preserves the storage warning", () => {
  const html = renderPage({
    cards: [],
    r2Usage: { usedBytes: 90, reservedBytes: 0, maxBytes: 100, lastReconciledAtMs: null },
  });
  assert.match(html, /feature directory is unavailable/);
  assert.match(html, /Reload feature directory/);
  assert.match(html, /Managed storage/);
  assert.doesNotMatch(html, /Everything configured is operating normally/);
  assert.doesNotMatch(html, /Run staff operations/);
});

test("AdminOverviewPage uses responsive semantic feature cards with representative links", () => {
  const html = renderPage({
    cards: [
      cards[0]!,
      cards[1]!,
      cards[2]!,
      cards[3]!,
      {
        id: "image-rules",
        label: "Image Rules",
        path: "/admin/image-rules",
        status: "configured",
        detail: "Ready but disabled",
        locked: false,
        readiness: "ready_disabled",
      },
    ],
  });

  assert.match(html, /<section[^>]+aria-labelledby="all-features-heading"/);
  assert.match(html, /<ul class="grid list-none grid-cols-1[^"]*sm:grid-cols-2[^"]*lg:grid-cols-3/);
  assert.match(html, /href="\/admin\/guild-1\/blocklist\?tab=blocklist"/);
  assert.match(html, /href="\/admin\/guild-1\/tickets\?tab=panel"/);
  assert.match(html, /href="\/admin\/guild-1\/lfg"/);
  assert.match(html, /href="\/admin\/guild-1\/image-rules"/);
  assert.match(html, /data-feature-state="Configured"/);
  assert.match(html, /data-feature-state="Needs attention"/);
  assert.match(html, /data-feature-state="Not set up"/);
  assert.match(html, /data-feature-state="Inactive"/);
  assert.match(html, /data-feature-state="Paid plan"/);
  assert.match(
    html,
    /<a href="\/admin\/billing\?feature=events&amp;plan=premium"[^>]+data-feature-id="events"/,
  );
  assert.match(html, /Events: view plan options/);
  assert.doesNotMatch(html, /Premium or Premium Plus unlocks Events/);
});

test("AdminOverviewPage opens the Reaction Rules wizard when setup is incomplete", () => {
  const html = renderPage({
    cards: [
      {
        id: "reaction-rules",
        label: "Reaction Rules",
        path: "/admin/blocklist",
        status: "not-set-up",
        detail: "No blocked emoji",
        locked: false,
        readiness: "setup_incomplete",
      },
    ],
  });

  assert.match(html, /href="\/admin\/guild-1\/blocklist\?tab=blocklist&amp;wizard=1"/);
});

test("AdminOverviewPage shows configured but inactive and dormant features", () => {
  const html = renderPage({
    cards: [
      {
        id: "image-rules",
        label: "Image Rules",
        path: "/admin/image-rules",
        status: "configured",
        detail: "Ready but disabled",
        locked: false,
        readiness: "ready_disabled",
      },
      {
        id: "bot-defense",
        label: "Bot Defense",
        path: "/admin/bot-defense",
        status: "configured",
        detail: "Rate Detector dormant; Honeypot available",
        locked: false,
        readiness: "dormant",
      },
    ],
  });

  assert.match(html, /Image Rules/);
  assert.match(html, /Ready but inactive/);
  assert.match(html, /Bot Defense/);
  assert.match(html, /Not currently effective/);
});

test("AdminOverviewPage keeps non-active White-Label Bot lifecycle states actionable", () => {
  const html = renderPage({
    cards: [
      {
        id: "white-label-bot",
        label: "White-Label Bot",
        path: "",
        status: "configured",
        detail: "Suspended",
        locked: false,
      },
    ],
  });

  assert.match(html, /White-Label Bot/);
  assert.match(html, /Suspended/);
  assert.doesNotMatch(html, /Review ↗/);
});

test("AdminOverviewPage hides storage below 80 percent", () => {
  const html = renderPage({
    r2Usage: {
      usedBytes: 70,
      reservedBytes: 9,
      maxBytes: 100,
      lastReconciledAtMs: null,
    },
  });

  assert.doesNotMatch(html, /Managed storage/);
  assert.match(html, /Everything configured is operating normally/);
});

test("AdminOverviewPage surfaces storage at or above 80 percent including reservations", () => {
  const usage = {
    usedBytes: 70 * 1024 * 1024,
    reservedBytes: 15 * 1024 * 1024,
    maxBytes: 100 * 1024 * 1024,
    lastReconciledAtMs: null,
  };
  const html = renderPage({ r2Usage: usage }).replaceAll("<!-- -->", "");

  assert.match(html, /Managed storage/);
  assert.match(html, /85\.0 MB of 100\.0 MB/);
  assert.match(html, /including 15\.0 MB reserved/);
  assert.match(html, /85% used/);
  assert.match(html, /Review plan/);
  assert.ok(getStorageWarning(usage));
});

test("storage plan review retains the selected workspace and Guild", () => {
  const html = renderPage({
    selectedWorkspaceId: "workspace-1",
    selectedGuildId: "1234567890",
    r2Usage: { usedBytes: 85, reservedBytes: 0, maxBytes: 100, lastReconciledAtMs: null },
  });

  assert.match(
    html,
    /href="\/admin\/billing\?workspaceId=workspace-1&amp;guildId=guild_1234567890">Review plan/,
  );
});

test("AdminOverviewPage shows one recommendation only when nothing needs attention", () => {
  const healthyHtml = renderPage({
    tier: "premium",
    cards: [cards[0]!],
    recommendedNextStep: recommendation,
  });
  const attentionHtml = renderPage({
    tier: "premium",
    cards,
    recommendedNextStep: recommendation,
  });

  assert.match(healthyHtml, /Recommended next improvement/);
  assert.match(healthyHtml, /Set up Mention Protection/);
  assert.doesNotMatch(attentionHtml, /Recommended next improvement/);
});

test("AdminOverviewPage renders a healthy state and All features when there is no action or recommendation", () => {
  const html = renderPage({ tier: "premium_plus", cards: [cards[0]!] });

  assert.match(html, /Premium Plus/);
  assert.match(html, /Everything configured is operating normally/);
  assert.match(html, /All features/);
  assert.match(html, />Configured</);
});

test("AdminOverviewPage lets an administrator start from a community goal", () => {
  const html = renderPage({
    cards: [
      { ...cards[0]!, status: "not-set-up", readiness: "not_setup" },
      { ...cards[1]!, status: "not-set-up", detail: null, readiness: "not_setup" },
    ],
  });

  assert.match(html, /Set up HAF around your goal/);
  assert.match(html, /Protect the community/);
  assert.match(html, /Run staff operations/);
  assert.match(html, /href="\/admin\/guild-1\/blocklist\?tab=blocklist&amp;wizard=1"/);
  assert.match(html, /href="\/admin\/guild-1\/tickets\?tab=panel&amp;wizard=1"/);
});

test("attention items prioritize broken and incomplete setup before inactive features", () => {
  const items = getOverviewAttentionItems([
    {
      card: {
        id: "inactive",
        label: "Inactive",
        path: "/admin/inactive",
        status: "configured",
        detail: null,
        locked: false,
        readiness: "ready_disabled",
      },
      href: "/admin/guild-1/inactive",
    },
    {
      card: {
        id: "broken",
        label: "Broken",
        path: "/admin/broken",
        status: "configured",
        detail: null,
        locked: false,
        readiness: "needs_attention",
      },
      href: "/admin/guild-1/broken",
    },
  ]);

  assert.deepEqual(
    items.map((item) => item.card.id),
    ["broken", "inactive"],
  );
});

function incidentFixture(id: string, overrides: Partial<OperationalIncidentView> = {}) {
  return {
    id,
    guildId: "guild-1",
    key: "managed-messages:message:" + id + ":publish-failed",
    feature: "managed-messages" as const,
    resource: { kind: "message", id: "message-" + id },
    condition: "publish-failed",
    severity: "error" as const,
    status: "open" as const,
    summaryCode: "managed_message_scheduled_publish_failed" as const,
    safeArgs: {},
    remediationCode: "retry_managed_message_draft" as const,
    firstSeenAtMs: Date.now() - 60_000,
    openSinceMs: Date.now() - 60_000,
    lastSeenAtMs: Date.now() - 1_000,
    resolvedAtMs: null,
    occurrenceCount: 1,
    lastCorrelationId: null,
    version: 1,
    summary: "Publish failed",
    impact: "The message was not published.",
    deepLink: "/admin/guild-1/managed-messages",
    remediation: {
      code: "retry_managed_message_draft" as const,
      label: "Retry publish",
      executable: true,
    },
    ...overrides,
  } satisfies OperationalIncidentView;
}

function createInteractiveEnv() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://example.com/admin/guild-1",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  return {
    dom,
    container,
    root,
    previousWindow,
    previousDocument,
    previousFetch,
    reactActEnvironment,
    previousActEnvironment,
  };
}

async function renderInteractivePage(
  env: ReturnType<typeof createInteractiveEnv>,
  incidents: OperationalIncidentView[],
  canRemediate: boolean,
  onRouteDataRefresh?: () => Promise<void>,
) {
  await act(async () => {
    env.root.render(
      <ToastProvider>
        <AdminOverviewPage
          selectedWorkspaceId="workspace-1"
          selectedGuildId="guild-1"
          tier="premium"
          cards={[]}
          openIncidents={incidents}
          canRemediate={canRemediate}
          onRouteDataRefresh={onRouteDataRefresh}
        />
      </ToastProvider>,
    );
  });
  await act(async () => undefined);
}

async function restoreInteractiveEnv(env: ReturnType<typeof createInteractiveEnv>) {
  await act(async () => env.root.unmount());
  Object.assign(globalThis, {
    window: env.previousWindow,
    document: env.previousDocument,
    fetch: env.previousFetch,
  });
  env.reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = env.previousActEnvironment;
  env.dom.window.close();
}

test("Operations inbox scopes pending state, prevents duplicate submits, and refreshes after success", async () => {
  const env = createInteractiveEnv();
  const responses: Array<Promise<Response>> = [];
  const resolveResponses: Array<(response: Response) => void> = [];
  const calls: RequestInit[] = [];
  const first = incidentFixture("incident-1");
  const second = incidentFixture("incident-2", {
    feature: "webhooks",
    remediation: { code: "review_webhook_destination", label: "Review webhook", executable: true },
  });
  Object.assign(globalThis, {
    window: env.dom.window,
    document: env.dom.window.document,
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      let resolveResponse!: (response: Response) => void;
      const response = new Promise<Response>((resolve) => (resolveResponse = resolve));
      responses.push(response);
      resolveResponses.push(resolveResponse);
      return response;
    },
  });
  let refreshCount = 0;
  try {
    await renderInteractivePage(env, [first, second], true, async () => {
      refreshCount += 1;
    });
    const buttons = [...env.container.querySelectorAll<HTMLButtonElement>("article button")];
    assert.equal(buttons.length, 2);
    const firstButton = buttons[0]!;
    const secondButton = buttons[1]!;
    await act(async () => {
      firstButton.dispatchEvent(new env.dom.window.MouseEvent("click", { bubbles: true }));
      firstButton.dispatchEvent(new env.dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(calls.length, 1);
    assert.equal(firstButton.disabled, true);
    assert.match(firstButton.textContent ?? "", /Retry publish…/);
    assert.equal(secondButton.disabled, false);

    resolveResponses[0]!(
      Response.json({
        ok: true,
        message: "Managed message retry started.",
        incident: null,
      }),
    );
    await act(async () => {
      await responses[0];
    });
    assert.equal(refreshCount, 1);
    assert.equal(firstButton.disabled, false);
    assert.match(env.container.textContent ?? "", /Managed message retry started\./);
    assert.doesNotMatch(env.container.textContent ?? "", /completed for managed-messages/);
  } finally {
    await restoreInteractiveEnv(env);
  }
});

test("Operations inbox reports remediation errors and restores the selected action", async () => {
  const env = createInteractiveEnv();
  const incident = incidentFixture("incident-error");
  let calls = 0;
  Object.assign(globalThis, {
    window: env.dom.window,
    document: env.dom.window.document,
    fetch: async () => {
      calls += 1;
      return adminErrorResponse("The incident changed; refresh and try again.", 409, {
        code: "conflict",
        correlationId: "ops-ref-123",
        retryable: false,
        action: "contact_support",
      });
    },
  });
  try {
    await renderInteractivePage(env, [incident], true);
    const button = env.container.querySelector<HTMLButtonElement>("article button");
    assert.ok(button);
    await act(async () => {
      button.dispatchEvent(new env.dom.window.MouseEvent("click", { bubbles: true }));
    });
    await act(async () => undefined);
    assert.equal(calls, 1);
    assert.equal(button.disabled, false);
    assert.match(env.container.textContent ?? "", /The incident changed; refresh and try again/);
    assert.match(env.container.textContent ?? "", /Reference: ops-ref-123/);
    assert.match(env.container.textContent ?? "", /Copy reference/);
  } finally {
    await restoreInteractiveEnv(env);
  }
});

test("Operations inbox distinguishes refresh failures from successful remediation", async () => {
  const env = createInteractiveEnv();
  const incident = incidentFixture("incident-refresh-error");
  Object.assign(globalThis, {
    window: env.dom.window,
    document: env.dom.window.document,
    fetch: async () =>
      Response.json({ ok: true, message: "Repair accepted by the server.", incident: null }),
  });
  try {
    await renderInteractivePage(env, [incident], true, async () => {
      throw new Error("Refresh unavailable");
    });
    const button = env.container.querySelector<HTMLButtonElement>("article button");
    assert.ok(button);
    await act(async () => {
      button.dispatchEvent(new env.dom.window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(env.container.textContent ?? "", /Repair accepted by the server\./);
    assert.match(
      env.container.textContent ?? "",
      /Repair succeeded, but the dashboard could not refresh\./,
    );
    assert.match(env.container.textContent ?? "", /Refresh unavailable/);
    assert.equal(button.disabled, false);
  } finally {
    await restoreInteractiveEnv(env);
  }
});

test("Operations inbox leaves remediation disabled and makes no request without write access", async () => {
  const env = createInteractiveEnv();
  let calls = 0;
  Object.assign(globalThis, {
    window: env.dom.window,
    document: env.dom.window.document,
    fetch: async () => {
      calls += 1;
      return Response.json({ ok: true });
    },
  });
  try {
    await renderInteractivePage(env, [incidentFixture("incident-read-only")], false);
    const button = env.container.querySelector<HTMLButtonElement>("article button");
    assert.ok(button);
    assert.equal(button.disabled, true);
    assert.equal(button.title, "Write access is required");
    await act(async () => {
      button.dispatchEvent(new env.dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(calls, 0);
  } finally {
    await restoreInteractiveEnv(env);
  }
});
