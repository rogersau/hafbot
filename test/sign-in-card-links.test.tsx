/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SignInCard } from "../src/admin/components/sign-in-card";

function renderSignIn(initialSearch = "") {
  return renderToStaticMarkup(<SignInCard initialSearch={initialSearch} onSignIn={() => {}} />);
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

test("sign-in footer exposes documentation and support", () => {
  assertHelpLinks(renderSignIn());
});

test("checkout-intent sign-in keeps documentation and support visible", () => {
  assertHelpLinks(renderSignIn("?next=%2Fadmin%2Fbilling%3Fplan%3Dpremium%26frequency%3Dmonthly"));
});
