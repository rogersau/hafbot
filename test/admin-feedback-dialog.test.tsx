/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-ignore -- Runtime tests compile via tsconfig.tests.json.
import test from "node:test";

import { buildFeedbackReportInput } from "../src/admin/components/admin-error-notice";
import {
  resolveFeedbackReturnFocus,
  resolveFeedbackScope,
} from "../src/admin/components/admin-feedback-dialog";
import {
  createFeedbackPayload,
  createFeedbackSubmitGuard,
  copyFeedbackReceipt,
  formatFeedbackFailure,
  parseFeedbackUserAgent,
  validateFeedback,
} from "../src/admin/components/admin-feedback-dialog-view";
import { AdminApiError } from "../src/admin/lib/api";

const snapshot = {
  route: "/admin/tickets",
  pageLabel: "Tickets",
  guildId: "123",
  workspaceId: "workspace-1",
  correlationId: "corr-123",
  errorCode: "discord_rate_limited",
  workerVersion: "worker-1",
};

test("feedback payload covers every category and exact opt-in/opt-out diagnostics", () => {
  for (const category of ["problem", "suggestion", "other"] as const) {
    const withoutDiagnostics = createFeedbackPayload(
      snapshot,
      category,
      " Summary ",
      " Description ",
      null,
    );
    assert.equal(withoutDiagnostics.category, category);
    assert.equal(withoutDiagnostics.summary, "Summary");
    assert.equal(withoutDiagnostics.description, "Description");
    assert.equal(withoutDiagnostics.diagnostics, undefined);
    assert.deepEqual(
      createFeedbackPayload(snapshot, category, "s", "d", { browser: "Chrome", os: "macOS" })
        .diagnostics,
      {
        included: true,
        browser: "Chrome",
        os: "macOS",
      },
    );
  }
});

test("Guild-scoped feedback omits an independently selected workspace", () => {
  assert.deepEqual(resolveFeedbackScope("guild-b", "workspace-a"), { guildId: "guild-b" });
  assert.deepEqual(resolveFeedbackScope("", "workspace-a"), { workspaceId: "workspace-a" });
});

test("feedback diagnostics detect Android before its Linux compatibility token", () => {
  assert.deepEqual(
    parseFeedbackUserAgent(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36",
    ),
    { browser: "Chrome", os: "Android" },
  );
});

test("feedback context is immutable, bounded, and error reports prefill safe fields", async () => {
  const payload = createFeedbackPayload(snapshot, "problem", "s", "d", null);
  assert.deepEqual(payload, {
    version: 1,
    category: "problem",
    summary: "s",
    description: "d",
    route: "/admin/tickets",
    pageLabel: "Tickets",
    guildId: "123",
    workspaceId: "workspace-1",
    correlationId: "corr-123",
    errorCode: "discord_rate_limited",
    workerVersion: "worker-1",
    diagnostics: undefined,
  });
  assert.equal(validateFeedback("", "description")?.includes("summary"), true);
  assert.equal(validateFeedback("summary", "")?.includes("description"), true);
  assert.equal(
    validateFeedback("a".repeat(201), "description"),
    "Enter a summary (1–200 characters) and description (1–4,000 characters).",
  );
  const input = buildFeedbackReportInput(
    new AdminApiError("Rate limited", 429, "discord_rate_limited", "corr-123", true, 30),
    "Rate limited",
    "corr-123",
  );
  assert.deepEqual(input, {
    category: "problem",
    summary: "Error discord_rate_limited: Rate limited",
    correlationId: "corr-123",
    errorCode: "discord_rate_limited",
  });
  assert.equal(
    formatFeedbackFailure(
      new AdminApiError("Rate limited", 429, "discord_rate_limited", "corr-123", true, 30),
    ),
    "Rate limited Try again in 30 seconds.",
  );
  assert.equal(
    formatFeedbackFailure(new Error("raw response body")),
    "Feedback could not be sent. Please try again.",
  );
  let copied = "";
  await copyFeedbackReceipt(async (value) => {
    copied = value;
  }, "FB-123");
  assert.equal(copied, "FB-123");
});

test("feedback submission guard suppresses synchronous duplicate clicks and UI stays shell-owned", () => {
  const guard = createFeedbackSubmitGuard();
  assert.equal(guard.tryStart(), true);
  assert.equal(guard.tryStart(), false);
  guard.finish();
  assert.equal(guard.tryStart(), true);
  const shell = readFileSync("src/admin/components/admin-shell.tsx", "utf8");
  const header = readFileSync("src/admin/components/admin-shell-header.tsx", "utf8");
  const dialog = readFileSync("src/admin/components/admin-feedback-dialog-view.tsx", "utf8");
  assert.match(shell, /Send feedback/);
  assert.match(header, /Send feedback/);
  assert.match(header, /returnFocus: accountMenuTriggerRef\.current/);
  assert.match(dialog, /copyReceipt/);
  assert.doesNotMatch(dialog, /localStorage|sessionStorage|document\.cookie|console\./);
});

test("feedback focus restoration prefers an explicit visible trigger", () => {
  const hiddenMenuItem = { focus() {} } as HTMLElement;
  const accountTrigger = { focus() {} } as HTMLElement;
  assert.equal(resolveFeedbackReturnFocus(accountTrigger, hiddenMenuItem), accountTrigger);
  assert.equal(resolveFeedbackReturnFocus(undefined, hiddenMenuItem), hiddenMenuItem);
});
