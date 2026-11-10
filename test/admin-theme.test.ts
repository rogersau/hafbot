/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { JSDOM } from "jsdom";

import { resolveTheme } from "../src/runtime/theme";
import { ADMIN_THEME_FOUC_SCRIPT } from "../src/runtime/admin-theme-fouc";

test("resolveTheme returns the explicit theme regardless of the system preference", () => {
  const cases: Array<{
    theme: "system" | "light" | "dark";
    systemPrefersDark: boolean;
    expected: "dark" | "light";
  }> = [
    { theme: "dark", systemPrefersDark: true, expected: "dark" },
    { theme: "dark", systemPrefersDark: false, expected: "dark" },
    { theme: "light", systemPrefersDark: true, expected: "light" },
    { theme: "light", systemPrefersDark: false, expected: "light" },
  ];

  for (const { theme, systemPrefersDark, expected } of cases) {
    assert.equal(
      resolveTheme(theme, systemPrefersDark),
      expected,
      `resolveTheme(${JSON.stringify(theme)}, ${systemPrefersDark})`,
    );
  }
});

test("resolveTheme resolves system mode against the OS preference", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});

interface FoucFixture {
  cookie?: string;
  prefersDark?: boolean;
}

function runFoucScript(fixture: FoucFixture = {}): { htmlClass: string; cookie: string } {
  const dom = new JSDOM("<!DOCTYPE html><html lang='en'><head></head><body></body></html>", {
    url: "https://example.com/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // jsdom does not implement prefers-color-scheme; stub matchMedia before the
  // script runs so the resolution chain is deterministic.
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: fixture.prefersDark ?? false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
  if (fixture.cookie) {
    // jsdom owns document.cookie; inject the value before running the script.
    window.document.cookie = fixture.cookie;
  }

  // Execute the script as a real <script> element so `document` and `window`
  // resolve exactly as they would in a browser (the FOUC script's real home).
  const script = window.document.createElement("script");
  script.textContent = ADMIN_THEME_FOUC_SCRIPT;
  window.document.head.appendChild(script);

  return {
    htmlClass: window.document.documentElement.className,
    cookie: window.document.cookie,
  };
}

function readThemeCookie(cookie: string): string | null {
  const match = /(?:^|; )theme=(dark|light)/.exec(cookie);
  return match ? match[1] : null;
}

test("FOUC script applies dark and backfills the cookie when the system prefers dark", () => {
  const { htmlClass, cookie } = runFoucScript({ prefersDark: true });

  assert.equal(htmlClass, "dark");
  assert.equal(readThemeCookie(cookie), "dark");
});

test("FOUC script applies light when the system prefers light", () => {
  const { htmlClass, cookie } = runFoucScript({ prefersDark: false });

  assert.equal(htmlClass, "light");
  assert.equal(readThemeCookie(cookie), "light");
});

test("FOUC script honours the theme=light cookie over the system preference", () => {
  const { htmlClass, cookie } = runFoucScript({ cookie: "theme=light", prefersDark: true });

  assert.equal(htmlClass, "light");
  assert.equal(readThemeCookie(cookie), "light");
});

test("FOUC script honours the theme=dark cookie over the system preference", () => {
  const { htmlClass, cookie } = runFoucScript({ cookie: "theme=dark", prefersDark: false });

  assert.equal(htmlClass, "dark");
  assert.equal(readThemeCookie(cookie), "dark");
});

test("FOUC script falls through to the media query when the cookie is malformed", () => {
  const { htmlClass } = runFoucScript({ cookie: "theme=midnight", prefersDark: true });

  assert.equal(htmlClass, "dark");
});
