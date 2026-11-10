/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import { act } from "react";
import { ticketsClient } from "../src/admin/generated/admin-client/tickets";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { buildTicketsTabHref, getTicketsTabFromSearch } from "../src/admin/lib/admin-route-state";

test("Ticket history is a supported Tickets tab", () => {
  assert.equal(getTicketsTabFromSearch("?tab=history"), "history");
  assert.equal(
    buildTicketsTabHref("/admin/guild-1/tickets?panelId=panel-1", "history"),
    "/admin/guild-1/tickets?panelId=panel-1&tab=history",
  );
});

import { withAdminDom } from "./support/admin-dom";

test("Ticket history uses the server preview and sends its token only after confirmation", async () => {
  await withAdminDom(async (ui) => {
    const { TicketPanelHistory, formatRevisionPath } =
      await import("../src/admin/components/ticket-panel-history");
    assert.equal(
      formatRevisionPath("ticketTypes.0.supportRoleId"),
      "Ticket types #0 › Support role ID",
    );
    const { ToastProvider } = await import("../src/admin/components/toast");
    const revision = {
      id: "revision-1",
      operation: "update",
      source: "dashboard-save",
      actorUserId: "user-1",
      operationId: "operation-1",
      correlationId: null,
      previousRevisionId: null,
      restoredFromRevisionId: null,
      snapshotHash: "hash-1",
      createdAtMs: 1,
      guildId: "guild-1",
      feature: "tickets",
      resourceKey: "main",
      schemaVersion: 1,
      snapshotJson: "{}",
    };
    const writes: Array<{ path: string; body: unknown }> = [];
    let previews = 0;
    let restored = false;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), "https://example.com");
      if (init?.method !== "POST") {
        assert.equal(url.searchParams.get("guildId"), "guild-1");
        assert.equal(url.searchParams.get("workspaceId"), "workspace-1");
        return url.pathname.endsWith("/revisions")
          ? Response.json({ revisions: [revision], nextCursor: null })
          : Response.json({ revision, diff: [] });
      }
      const body = JSON.parse(String(init.body));
      writes.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/restore-preview")) {
        assert.deepEqual(body, {
          guildId: "guild-1",
          workspaceId: "workspace-1",
          revisionId: "revision-1",
        });
        if (++previews === 1) throw new Error("Preview unavailable");
        return Response.json({
          diff: [
            {
              path: "panelName",
              label: "Server-approved panel name",
              kind: "changed",
              before: "Current name",
              after: "Restored name",
            },
          ],
          warnings: ["Republish the panel after restoring."],
          requiredSecretInputs: [],
          followUpActions: [],
          previewToken: "server-preview-token",
          expiresAtMs: 9999999999999,
          destructive: false,
        });
      }
      assert.equal(url.pathname, "/admin/api/tickets/panel/revision/restore");
      assert.deepEqual(body, {
        guildId: "guild-1",
        workspaceId: "workspace-1",
        revisionId: "revision-1",
        previewToken: "server-preview-token",
      });
      return Response.json({ ok: true, panel: null, followUpActions: [] });
    };
    await ui.render(
      <ToastProvider>
        <TicketPanelHistory
          guildId="guild-1"
          selectedWorkspaceId="workspace-1"
          panelId="main"
          onRestored={(panel) => {
            assert.equal(panel, null);
            restored = true;
          }}
        />
      </ToastProvider>,
    );
    const review = [...ui.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Review"),
    );
    assert.ok(review);
    const { act } = await import("react");
    await act(async () => review.click());
    await ui.click("Preview restore");
    assert.match(ui.container.textContent ?? "", /Preview unavailable/);
    assert.equal(writes.length, 1);
    assert.equal(restored, false);
    await ui.click("Preview restore");
    assert.match(ui.container.textContent ?? "", /Server-approved panel name/);
    assert.match(ui.container.textContent ?? "", /Restored name/);
    assert.match(ui.container.textContent ?? "", /Republish the panel/);
    await ui.click("Restore this revision");
    await ui.click("Cancel");
    assert.equal(writes.length, 2, "cancel must not submit a restore");
    await ui.click("Restore this revision");
    await ui.click("Restore revision");
    assert.equal(writes.length, 3);
    assert.equal(restored, true);
    assert.match(document.body.textContent ?? "", /Ticket Panel revision restored/);
  });
});

test("Ticket history loads older changes once, keeps selection, and retries failed pages", async (t) => {
  const first = revision("revision-3", 3_000);
  const second = revision("revision-2", 2_000);
  const oldest = revision("revision-1", 1_000);
  const failedPage = deferred<RevisionPage>();
  const queries: HistoryQuery[] = [];
  t.mock.method(ticketsClient, "revisions", async (query: HistoryQuery) => {
    queries.push(query);
    if (queries.length === 1) return { revisions: [first, second], nextCursor: 2_000 };
    if (queries.length === 2) return failedPage.promise;
    return { revisions: [second, oldest, oldest], nextCursor: null };
  });
  t.mock.method(ticketsClient, "revision", async () => revisionDetail(second));
  await withHistoryDom(async (env) => {
    await env.render();
    await act(async () => reviewButtons(env.container)[1]!.click());
    assert.match(env.container.textContent ?? "", /Restore preview/);
    const selected = reviewButtons(env.container)[1]!;
    assert.ok(selected.classList.contains("bg-accent"));

    const older = button(env.container, "Load older changes");
    await act(async () => {
      older.click();
      older.click();
    });
    assert.equal(queries.length, 2);
    assert.deepEqual(queries[1], {
      workspaceId: "workspace-1",
      guildId: "guild-1",
      panelId: "panel-1",
      limit: "50",
      beforeCreatedAtMs: "2000",
    });
    assert.equal(button(env.container, "Loading older changes…").disabled, true);
    assert.equal(button(env.container, "Refresh").disabled, true);
    assert.equal(reviewButtons(env.container).length, 2);
    assert.match(env.container.textContent ?? "", /Restore preview/);

    await act(async () => failedPage.reject(new Error("History temporarily unavailable")));
    assert.match(
      env.container.querySelector('[role="alert"]')?.textContent ?? "",
      /temporarily unavailable/,
    );
    assert.equal(reviewButtons(env.container).length, 2);
    assert.ok(selected.classList.contains("bg-accent"));
    assert.match(env.container.textContent ?? "", /Restore preview/);

    await act(async () => button(env.container, "Load older changes").click());
    assert.equal(queries.length, 3);
    assert.equal(queries[2]?.beforeCreatedAtMs, "2000");
    assert.equal(reviewButtons(env.container).length, 3);
    assert.doesNotMatch(env.container.textContent ?? "", /History temporarily unavailable/);
    assert.ok(selected.classList.contains("bg-accent"));
    assert.match(env.container.textContent ?? "", /Restore preview/);
    assert.match(env.container.textContent ?? "", /All recorded changes are shown/);
    assert.ok(!findButton(env.container, "Load older changes"));
  });
});

test("Ticket history ignores a late older page after changing panels", async (t) => {
  const oldPage = deferred<RevisionPage>();
  t.mock.method(ticketsClient, "revisions", async (query: HistoryQuery) => {
    if (query.panelId === "panel-2") {
      return { revisions: [revision("current-panel", 4_000)], nextCursor: null };
    }
    if (query.beforeCreatedAtMs) return oldPage.promise;
    return { revisions: [revision("old-panel", 3_000)], nextCursor: 3_000 };
  });
  await withHistoryDom(async (env) => {
    await env.render();
    await act(async () => button(env.container, "Load older changes").click());
    await env.render("guild-1", "panel-2");
    const currentText = env.container.textContent;
    await act(async () => {
      oldPage.resolve({ revisions: [revision("old-panel-older", 2_000)], nextCursor: 2_000 });
    });
    assert.equal(env.container.textContent, currentText);
    assert.equal(reviewButtons(env.container).length, 1);
    assert.ok(!findButton(env.container, "Load older changes"));
  });
});

test("Ticket history ignores a late initial-load failure after changing Guilds", async (t) => {
  const oldPage = deferred<RevisionPage>();
  t.mock.method(ticketsClient, "revisions", async (query: HistoryQuery) => {
    if (query.guildId === "guild-1") return oldPage.promise;
    return { revisions: [revision("new-guild", 4_000)], nextCursor: null };
  });
  await withHistoryDom(async (env) => {
    await env.render();
    assert.match(env.container.textContent ?? "", /Loading Ticket Panel revision history/);
    await env.render("guild-2", "panel-2");
    await act(async () => oldPage.reject(new Error("Old Guild request failed")));
    assert.equal(reviewButtons(env.container).length, 1);
    assert.ok(env.container.querySelector('[role="alert"]') === null);
    assert.match(env.container.textContent ?? "", /All recorded changes are shown/);
  });
});

test("Ticket history keeps the latest reviewed revision when an earlier request finishes late", async (t) => {
  const first = revision("revision-2", 2_000);
  const second = revision("revision-1", 1_000);
  const oldDetail = deferred<Awaited<ReturnType<typeof ticketsClient.revision>>>();
  t.mock.method(ticketsClient, "revisions", async () => ({
    revisions: [first, second],
    nextCursor: null,
  }));
  t.mock.method(
    ticketsClient,
    "revision",
    async ({ revisionId }: Parameters<typeof ticketsClient.revision>[0]) =>
      revisionId === second.id ? oldDetail.promise : revisionDetail(first),
  );
  await withHistoryDom(async (env) => {
    await env.render();
    await act(async () => reviewButtons(env.container)[1]!.click());
    await act(async () => reviewButtons(env.container)[0]!.click());
    assert.ok(reviewButtons(env.container)[0]!.classList.contains("bg-accent"));
    await act(async () => oldDetail.resolve(revisionDetail(second)));
    assert.ok(reviewButtons(env.container)[0]!.classList.contains("bg-accent"));
    assert.equal(reviewButtons(env.container)[1]!.classList.contains("bg-accent"), false);
  });
});

test("Ticket history ignores a late restore preview after changing panels", async (t) => {
  const preview = deferred<Awaited<ReturnType<typeof ticketsClient.restorePreview>>>();
  t.mock.method(ticketsClient, "revisions", async ({ panelId }: HistoryQuery) => ({
    revisions: [revision(panelId, 3_000)],
    nextCursor: null,
  }));
  t.mock.method(
    ticketsClient,
    "revision",
    async ({ revisionId }: Parameters<typeof ticketsClient.revision>[0]) =>
      revisionDetail(revision(revisionId, 3_000)),
  );
  t.mock.method(ticketsClient, "restorePreview", async () => preview.promise);
  await withHistoryDom(async (env) => {
    await env.render();
    await act(async () => reviewButtons(env.container)[0]!.click());
    await act(async () => button(env.container, "Preview restore").click());
    assert.equal(reviewButtons(env.container)[0]!.disabled, true);
    await env.render("guild-1", "panel-2");
    await act(async () => reviewButtons(env.container)[0]!.click());
    assert.equal(button(env.container, "Preview restore").disabled, false);
    await act(async () => {
      preview.resolve({
        previewToken: "old-panel-token",
        diff: [],
        warnings: ["Old panel restore warning"],
        requiredSecretInputs: [],
        followUpActions: [],
        expiresAtMs: 10_000,
        destructive: false,
      });
    });
    assert.equal(button(env.container, "Preview restore").disabled, false);
    assert.doesNotMatch(env.container.textContent ?? "", /Old panel restore warning/);
    assert.ok(!findButton(env.container, "Restore this revision"));
  });
});

type RevisionPage = Awaited<ReturnType<typeof ticketsClient.revisions>>;
type HistoryQuery = Parameters<typeof ticketsClient.revisions>[0];

function revision(id: string, createdAtMs: number): RevisionPage["revisions"][number] {
  return {
    id,
    operation: "update",
    source: "dashboard-save",
    actorUserId: null,
    operationId: id,
    correlationId: null,
    previousRevisionId: null,
    restoredFromRevisionId: null,
    snapshotHash: id,
    createdAtMs,
  };
}

function revisionDetail(
  summary: RevisionPage["revisions"][number],
): Awaited<ReturnType<typeof ticketsClient.revision>> {
  return {
    revision: {
      ...summary,
      guildId: "guild-1",
      feature: "tickets",
      resourceKey: "panel-1",
      schemaVersion: 1,
      snapshotJson: "{}",
    },
    diff: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withHistoryDom(
  run: (env: {
    container: Element;
    render: (guildId?: string, panelId?: string) => Promise<void>;
  }) => Promise<void>,
) {
  await withAdminDom(async (ui) => {
    const { TicketPanelHistory } = await import("../src/admin/components/ticket-panel-history");
    const { ToastProvider } = await import("../src/admin/components/toast");
    await run({
      container: ui.container,
      render: async (guildId = "guild-1", panelId = "panel-1") =>
        ui.render(
          <ToastProvider>
            <TicketPanelHistory
              selectedWorkspaceId="workspace-1"
              guildId={guildId}
              panelId={panelId}
              onRestored={() => {}}
            />
          </ToastProvider>,
        ),
    });
  });
}

function reviewButtons(container: Element): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter((candidate) =>
    candidate.textContent?.endsWith("Review"),
  );
}

function findButton(container: Element, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
}

function button(container: Element, text: string): HTMLButtonElement {
  const found = findButton(container, text);
  assert.ok(found, `Button not found: ${text}`);
  return found;
}
