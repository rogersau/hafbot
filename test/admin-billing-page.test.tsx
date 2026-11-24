import { adminErrorResponse } from "./support/admin-error-response";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RouterProvider } from "@tanstack/react-router";
import { DEFAULT_USER_PREFERENCES } from "../src/runtime/admin-types";
import { createFixtureRouter } from "./support/admin-app";
import "./support/admin-page-test-loader";

type Env = {
  dom: JSDOM;
  root: ReturnType<typeof createRoot>;
  container: HTMLElement;
  restore(): Promise<void>;
};

const subscription = (
  plan: "free" | "premium" | "premium_plus",
  frequency: "monthly" | "yearly" | null = null,
) => ({
  ownerId: "owner",
  customerId: "customer",
  subscriptionId: plan === "free" ? null : "sub",
  priceId: plan === "free" ? null : `${plan === "premium" ? "premium" : "plus"}-${frequency}`,
  productId: plan === "free" ? null : "product",
  plan,
  frequency,
  status: plan === "free" ? "missing" : "active",
  currentPeriodStartMs: null,
  currentPeriodEndMs: null,
  cancelAtPeriodEnd: false,
  cancelledAtMs: null,
  latestInvoiceId: null,
  scheduleId: null,
  observedAtMs: 1,
  quarantineReason: null,
  pricingCohort: null,
});

const billing = (
  plan: "free" | "premium" | "premium_plus" = "free",
  frequency: "monthly" | "yearly" | null = null,
) => ({
  subscription: subscription(plan, frequency),
  catalog: [
    {
      priceId: "premium-monthly",
      productId: "product",
      plan: "premium",
      frequency: "monthly",
    },
    {
      priceId: "premium-yearly",
      productId: "product",
      plan: "premium",
      frequency: "yearly",
    },
    {
      priceId: "plus-monthly",
      productId: "product",
      plan: "premium_plus",
      frequency: "monthly",
    },
    {
      priceId: "plus-yearly",
      productId: "product",
      plan: "premium_plus",
      frequency: "yearly",
    },
  ],
  prices: [
    {
      plan: "premium",
      frequency: "monthly",
      unitAmount: 100,
      currency: "aud",
      decimalAmount: "1.00",
      formattedAmount: "$1.00",
    },
    {
      plan: "premium",
      frequency: "yearly",
      unitAmount: 1000,
      currency: "aud",
      decimalAmount: "10.00",
      formattedAmount: "$10.00",
    },
    {
      plan: "premium_plus",
      frequency: "monthly",
      unitAmount: 200,
      currency: "aud",
      decimalAmount: "2.00",
      formattedAmount: "$2.00",
    },
    {
      plan: "premium_plus",
      frequency: "yearly",
      unitAmount: 2000,
      currency: "aud",
      decimalAmount: "20.00",
      formattedAmount: "$20.00",
    },
  ],
});

function createDom(search = ""): Env {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: `https://example.test/admin/billing${search}`,
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousSelf = globalThis.self;
  const reactEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = reactEnv.IS_REACT_ACT_ENVIRONMENT;
  reactEnv.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    self: dom.window,
  });
  const root = createRoot(dom.window.document);
  return {
    dom,
    root,
    get container() {
      return dom.window.document.body;
    },
    async restore() {
      await act(async () => root.unmount());
      Object.assign(globalThis, {
        window: previousWindow,
        document: previousDocument,
        self: previousSelf,
      });
      reactEnv.IS_REACT_ACT_ENVIRONMENT = previousAct;
      dom.window.close();
    },
  };
}

function response(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function errorResponse(message = "Billing unavailable") {
  return adminErrorResponse(message, 500, {
    code: "internal_error",
    correlationId: "corr-billing",
    retryable: true,
    action: "retry",
  });
}
function installFetch(handler: (input: string) => Promise<Response>): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = (input) => {
    const path = String(input);
    if (path.startsWith("/admin/api/billing")) return handler(path);
    if (path.startsWith("/admin/api/guilds")) return Promise.resolve(response({ guilds: [] }));
    if (path === "/admin/api/profile/preferences") {
      return Promise.resolve(response(DEFAULT_USER_PREFERENCES));
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  return () => {
    globalThis.fetch = previous;
  };
}
async function render(env: Env) {
  const { pathname, search, hash } = env.dom.window.location;
  const router = createFixtureRouter(`${pathname}${search}${hash}`);
  await act(async () => {
    env.root.render(<RouterProvider router={router} />);
  });
  return router;
}
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

test("Billing retries failed secondary sections independently of the subscription", async () => {
  const requests: string[] = [];
  const attempts = new Map<string, number>();
  const restoreFetch = installFetch(async (input) => {
    const path = String(input);
    requests.push(path);
    attempts.set(path, (attempts.get(path) ?? 0) + 1);
    if (path.endsWith("/billing")) return response(billing("premium", "monthly"));
    if (path.endsWith("/billing/history")) {
      return attempts.get(path) === 1
        ? errorResponse("History unavailable")
        : response({ events: [] });
    }
    assert.ok(path.endsWith("/billing/assignments"), path);
    return attempts.get(path) === 1
      ? errorResponse("Assignments unavailable")
      : response({ assignments: [], eligibleGuilds: [], capacity: 1 });
  });
  const env = createDom();
  try {
    await render(env);
    await settle();
    assert.match(env.container.textContent ?? "", /Assignments unavailable/);
    assert.match(env.container.textContent ?? "", /History unavailable/);
    const retry = (label: string) => {
      const button = [...env.container.querySelectorAll("button")].find(
        (element) => element.textContent?.trim() === label,
      );
      assert.ok(button, label);
      return act(async () => button.click());
    };
    await retry("Retry guild assignments");
    assert.doesNotMatch(env.container.textContent ?? "", /Assignments unavailable/);
    assert.match(env.container.textContent ?? "", /No eligible Discord servers/);
    assert.match(env.container.textContent ?? "", /History unavailable/);
    await retry("Retry recent billing activity");
    assert.doesNotMatch(env.container.textContent ?? "", /History unavailable/);
    assert.equal(requests.filter((path) => path.endsWith("/billing")).length, 1);
  } finally {
    restoreFetch();
    await env.restore();
  }
});

test("Billing explains unavailable current prices without showing retired launch terms", async () => {
  const data = { ...billing("premium", "monthly"), catalog: [] };
  const restoreFetch = installFetch(async (input) => {
    if (String(input).endsWith("/billing")) return response(data);
    if (String(input).endsWith("/billing/history")) return response({ events: [] });
    return response({ assignments: [], eligibleGuilds: [], capacity: 1 });
  });
  const env = createDom();
  try {
    await render(env);
    await settle();
    assert.match(env.container.textContent ?? "", /Current plan prices are unavailable/);
    assert.doesNotMatch(
      env.container.textContent ?? "",
      /founder|places claimed|cannot be reclaimed/i,
    );
    assert.equal(env.container.querySelector('[aria-label="Billing frequency"]'), null);
    assert.ok(
      [...env.container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Manage billing"),
      ),
    );
    assert.ok(
      [...env.container.querySelectorAll("button")].every(
        (button) => !/Upgrade|Downgrade|Switch to/.test(button.textContent ?? ""),
      ),
    );
  } finally {
    restoreFetch();
    await env.restore();
  }
});

test("Billing shows the same selected amount and server assignment before sending a buyer to Stripe", async () => {
  const restoreFetch = installFetch(async (path) => {
    if (path.endsWith("/billing")) return response(billing());
    if (path.endsWith("/billing/history")) return response({ events: [] });
    assert.fail(`Unexpected request before explicit checkout: ${path}`);
  });
  const env = createDom("?plan=premium_plus&frequency=yearly");
  try {
    await render(env);
    await settle();
    const text = env.container.textContent ?? "";
    assert.match(text, /Your Premium Plus selection is ready\$20\.00 AUD \/ year/);
    assert.match(text, /choose up to three eligible Discord servers in Billing/);
    assert.match(text, /does not upgrade all your servers/);
    const choose = [...env.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Choose Premium Plus",
    );
    assert.equal(choose?.disabled, false);
  } finally {
    restoreFetch();
    await env.restore();
  }
});

test("Billing will not offer checkout before a current price can be shown", async () => {
  const restoreFetch = installFetch(async (path) => {
    if (path.endsWith("/billing")) return response({ ...billing(), prices: [] });
    if (path.endsWith("/billing/history")) return response({ events: [] });
    assert.fail(`Unexpected checkout request: ${path}`);
  });
  const env = createDom("?plan=premium&frequency=monthly");
  try {
    await render(env);
    await settle();
    assert.match(
      env.container.textContent ?? "",
      /Checkout is unavailable until the current price can be shown/,
    );
    const buttons = [...env.container.querySelectorAll("button")].filter((button) =>
      button.textContent?.startsWith("Choose Premium"),
    );
    assert.equal(buttons.length, 2);
    assert.ok(buttons.every((button) => button.disabled));
  } finally {
    restoreFetch();
    await env.restore();
  }
});

test("Billing keeps initial loading separate from loaded and error states", async () => {
  let resolveSummary!: (value: Response) => void;
  let resolveHistory!: (value: Response) => void;
  const summary = new Promise<Response>((resolve) => {
    resolveSummary = resolve;
  });
  const history = new Promise<Response>((resolve) => {
    resolveHistory = resolve;
  });
  const restoreFetch = installFetch((path) => (path.endsWith("/billing") ? summary : history));
  const env = createDom();
  try {
    await render(env);
    assert.match(env.container.textContent ?? "", /Loading Billing/);
    resolveSummary(response(billing()));
    await settle();
    assert.doesNotMatch(env.container.textContent ?? "", /Loading Billing/);
    assert.match(env.container.textContent ?? "", /Current plan/);
    assert.match(env.container.textContent ?? "", /Loading billing activity/);
    resolveHistory(response({ events: [] }));
    await settle();
    assert.doesNotMatch(env.container.textContent ?? "", /Loading billing activity/);
  } finally {
    restoreFetch();
    await env.restore();
  }
});

test("Billing failure exposes safe retry, prevents duplicates, and recovers", async () => {
  let calls = 0;
  let resolveRetry!: (value: Response) => void;
  const retry = new Promise<Response>((r) => {
    resolveRetry = r;
  });
  const restoreFetch = installFetch(async (path) => {
    if (path.endsWith("/billing/history")) return response({ events: [] });
    if (path.endsWith("/billing/assignments")) {
      return response({ assignments: [], eligibleGuilds: [], capacity: 1 });
    }
    assert.ok(path.endsWith("/billing"), path);
    return ++calls === 1 ? errorResponse() : retry;
  });
  const env = createDom();
  try {
    await render(env);
    await settle();
    assert.equal(calls, 1);
    assert.match(env.container.textContent ?? "", /Reference: corr-billing/);
    assert.match(env.container.textContent ?? "", /Retry/);
    assert.doesNotMatch(env.container.textContent ?? "", /Loading Billing/);
    const button = [...env.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Retry",
    );
    assert.ok(button);
    await act(async () => {
      button.click();
      button.click();
    });
    assert.equal(calls, 2);
    assert.match(env.container.textContent ?? "", /Retrying Billing/);
    resolveRetry(response(billing("premium", "monthly")));
    await settle();
    assert.match(env.container.textContent ?? "", /Current plan/);
    assert.match(env.container.textContent ?? "", /Premium/);
  } finally {
    restoreFetch();
    await env.restore();
  }
});

test("Billing preserves requested plan/frequency and recovers checkout sync failures", async () => {
  let syncCalls = 0;
  const restoreFetch = installFetch(async (input) => {
    if (String(input).endsWith("/billing/sync")) {
      syncCalls++;
      return syncCalls === 1
        ? errorResponse("Sync failed")
        : response({ subscription: subscription("premium_plus", "monthly") });
    }
    if (String(input).endsWith("/billing")) return response(billing("premium_plus", "monthly"));
    if (String(input).endsWith("/billing/history")) return response({ events: [] });
    return response({ assignments: [], eligibleGuilds: [], capacity: 1 });
  });
  const env = createDom("?checkout=success&session_id=s1&plan=premium_plus&frequency=monthly");
  try {
    await render(env);
    await settle();
    assert.match(env.container.textContent ?? "", /Sync failed/);
    const retry = [...env.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Retry",
    );
    assert.ok(retry);
    await act(async () => retry.click());
    await settle();
    assert.equal(syncCalls, 2);
    assert.match(env.container.textContent ?? "", /Premium Plus/);
    assert.ok(
      env.container
        .querySelector('[aria-label="Billing frequency"] button[aria-pressed="true"]')
        ?.textContent?.includes("monthly"),
    );
  } finally {
    restoreFetch();
    await env.restore();
  }
});

test("Billing syncs a checkout on navigation and retries a failed read without posting again", async () => {
  let syncCalls = 0;
  let summaryCalls = 0;
  const restoreFetch = installFetch(async (input) => {
    const path = String(input);
    if (path.endsWith("/billing/sync")) {
      syncCalls++;
      return response({ subscription: subscription("premium_plus", "monthly") });
    }
    if (path.endsWith("/billing/history")) return response({ events: [] });
    if (path.endsWith("/billing/assignments")) {
      return response({ assignments: [], eligibleGuilds: [], capacity: 1 });
    }
    assert.ok(path.endsWith("/billing"), path);
    summaryCalls++;
    if (summaryCalls === 2) return errorResponse("Summary unavailable");
    return response(syncCalls ? billing("premium_plus", "monthly") : billing());
  });
  const env = createDom();
  try {
    const router = await render(env);
    await settle();
    assert.equal(summaryCalls, 1);
    const checkout = {
      to: "/admin/billing" as const,
      search: {
        checkout: "success",
        session_id: "s1",
        plan: "premium_plus",
        frequency: "monthly",
        workspaceId: "workspace-1",
      },
      hash: "assignments",
    };
    await act(async () => {
      await router.preloadRoute(checkout);
    });
    assert.equal(syncCalls, 0);
    assert.equal(summaryCalls, 1);

    await act(async () => {
      await router.navigate(checkout);
    });
    await settle();
    assert.equal(syncCalls, 1);
    assert.equal(summaryCalls, 2);
    assert.match(env.container.textContent ?? "", /Summary unavailable/);
    assert.deepEqual(
      { ...router.state.location.search },
      { plan: "premium_plus", frequency: "monthly", workspaceId: "workspace-1" },
    );
    assert.equal(router.state.location.hash, "assignments");

    const retry = [...env.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Retry",
    );
    assert.ok(retry);
    await act(async () => retry.click());
    await settle();
    assert.equal(summaryCalls, 3);
    assert.equal(syncCalls, 1);
    assert.match(env.container.textContent ?? "", /Premium Plus/);
  } finally {
    restoreFetch();
    await env.restore();
  }
});

test("Billing highlights requested plan and applies frequency query on free plan", async () => {
  const restoreFetch = installFetch(async (input) => {
    if (String(input).endsWith("/billing")) return response(billing());
    if (String(input).endsWith("/billing/history")) return response({ events: [] });
    return response({ assignments: [], eligibleGuilds: [], capacity: 1 });
  });
  const env = createDom("?plan=premium_plus&frequency=monthly");
  try {
    await render(env);
    await settle();
    assert.match(env.container.textContent ?? "", /Your Premium Plus selection is ready/);
    assert.ok(
      env.container
        .querySelector('[aria-label="Billing frequency"] button[aria-pressed="true"]')
        ?.textContent?.includes("monthly"),
    );
  } finally {
    restoreFetch();
    await env.restore();
  }
});
