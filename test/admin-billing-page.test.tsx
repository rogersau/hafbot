/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile via tsconfig.tests.json.
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { AdminBillingPage } from "../src/admin/components/admin-billing-page";
import { ToastProvider } from "../src/admin/components/toast";

type Env = {
  dom: JSDOM;
  root: ReturnType<typeof createRoot>;
  container: HTMLElement;
  restore(): void;
};

const subscription = (
  plan: "free" | "premium" | "premium_plus",
  frequency: "monthly" | "yearly" | null = null,
) => ({
  ownerId: "owner",
  customerId: "customer",
  subscriptionId: plan === "free" ? null : "sub",
  priceId: plan === "free" ? null : "price",
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
      cohort: "standard",
    },
    {
      priceId: "premium-yearly",
      productId: "product",
      plan: "premium",
      frequency: "yearly",
      cohort: "standard",
    },
    {
      priceId: "plus-monthly",
      productId: "product",
      plan: "premium_plus",
      frequency: "monthly",
      cohort: "standard",
    },
    {
      priceId: "plus-yearly",
      productId: "product",
      plan: "premium_plus",
      frequency: "yearly",
      cohort: "standard",
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
  founderAdmission: null,
});

function createDom(search = ""): Env {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: `https://example.test/admin/billing${search}`,
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const reactEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = reactEnv.IS_REACT_ACT_ENVIRONMENT;
  reactEnv.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const rootContainer = container as HTMLElement;
  const root = createRoot(rootContainer);
  return {
    dom,
    root,
    container: rootContainer,
    async restore() {
      await act(async () => root.unmount());
      Object.assign(globalThis, { window: previousWindow, document: previousDocument });
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
  return new Response(
    JSON.stringify({
      error: message,
      code: "internal_error",
      correlationId: "corr-billing",
      retryable: true,
      action: "retry",
    }),
    { status: 500, headers: { "content-type": "application/json" } },
  );
}
function installFetch(handler: (input: string) => Promise<Response>): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}
async function render(env: Env) {
  await act(async () => {
    env.root.render(
      <ToastProvider>
        <AdminBillingPage />
      </ToastProvider>,
    );
  });
}
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

test("Billing explains unqualified Founder TEST subscriptions without offering a rejected plan change", async () => {
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
    assert.match(env.container.textContent ?? "", /pricing cohort has not been confirmed/);
    assert.match(
      env.container.textContent ?? "",
      /test subscriptions do not receive Founder status/,
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

test("Billing keeps initial loading separate from loaded and error states", async () => {
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>((r) => {
    resolve = r;
  });
  const restoreFetch = installFetch(async () => pending);
  const env = createDom();
  try {
    await render(env);
    assert.match(env.container.textContent ?? "", /Loading Billing/);
    resolve(response(billing()));
    await settle();
    assert.doesNotMatch(env.container.textContent ?? "", /Loading Billing/);
    assert.match(env.container.textContent ?? "", /Current plan/);
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
  const restoreFetch = installFetch(async () => (++calls === 1 ? errorResponse() : retry));
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
