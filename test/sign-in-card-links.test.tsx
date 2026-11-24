/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SignInCard } from "../src/admin/components/sign-in-card";
import type { PublicLandingPrice } from "../src/landing/landing-prices";

function renderSignIn(initialSearch = "", prices: PublicLandingPrice[] = []) {
  return renderToStaticMarkup(
    <SignInCard initialSearch={initialSearch} prices={prices} onSignIn={() => {}} />,
  );
}

function assertHelpLinks(markup: string) {
  assert.match(
    markup,
    /href="https:\/\/docs\.hafbot\.xyz\/getting-started"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>Documentation</,
  );
  assert.match(
    markup,
    /href="https:\/\/discord\.gg\/HpRPkdm6dv"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>Support</,
  );
  assert.match(markup, /href="\/terms"[^>]*>Terms of Service</);
  assert.match(markup, /href="\/privacy"[^>]*>Privacy Policy</);
}

test("sign-in and checkout review expose the same skip link and focusable main landmark", () => {
  for (const search of ["", "?next=%2Fadmin%2Fbilling%3Fplan%3Dpremium"]) {
    const markup = renderSignIn(search);
    assert.match(
      markup,
      /^<a[^>]*href="#main-content">Skip to main content<\/a><main id="main-content" tabindex="-1"/,
    );
    assert.equal([...markup.matchAll(/<h1(?:\s|>)/g)].length, 1);
  }
});

test("sign-in footer exposes documentation and support", () => {
  assertHelpLinks(renderSignIn());
});

test("checkout-intent sign-in keeps documentation and support visible", () => {
  assertHelpLinks(renderSignIn("?next=%2Fadmin%2Fbilling%3Fplan%3Dpremium%26frequency%3Dmonthly"));
});

test("checkout-intent sign-in shows the selected offer and assignment before Discord", () => {
  const markup = renderSignIn(
    "?next=%2Fadmin%2Fbilling%3Fplan%3Dpremium_plus%26frequency%3Dyearly",
    [
      {
        plan: "premium_plus",
        frequency: "monthly",
        currency: "aud",
        decimalAmount: "8.99",
        formattedAmount: "$8.99",
      },
      {
        plan: "premium_plus",
        frequency: "yearly",
        currency: "aud",
        decimalAmount: "80.00",
        formattedAmount: "$80.00",
      },
    ],
  );
  assert.match(markup, /Premium Plus yearly/);
  assert.match(markup, /\$80\.00 AUD \/ year/);
  assert.doesNotMatch(markup, /\$8\.99/);
  assert.match(markup, /choose up to three eligible Discord servers in Billing/);
  assert.match(markup, /does not upgrade all your servers/);
  assert.match(markup, /<button[^>]*>.*Continue with Discord.*<\/button>/);
});

test("unavailable checkout price offers ordinary sign-in without the selection", () => {
  const markup = renderSignIn("?next=%2Fadmin%2Fbilling%3Fplan%3Dpremium%26frequency%3Dmonthly");
  assert.match(markup, /Current price is unavailable/);
  assert.match(markup, /href="\/admin\/login"[^>]*>Sign in without a plan selection/);
  assert.doesNotMatch(markup, /<button[^>]*>.*Continue with Discord.*<\/button>/);
});
