import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createBrowserHistory } from "@tanstack/react-router";
import { JSDOM } from "jsdom";

const entries = [
  "/admin/docs-guild?workspaceId=docs-workspace",
  "/admin/docs-guild/blocklist?workspaceId=docs-workspace&tab=blocklist",
  "/admin/docs-guild/blocklist?workspaceId=docs-workspace&tab=limits#settings",
  "/admin/docs-guild?workspaceId=docs-workspace",
  "/admin/docs-guild/lfg?workspaceId=docs-workspace",
];

function nextPop(window) {
  return new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
}

test("container copies dependency patches before its frozen install", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  const dependencyStage = dockerfile.match(
    /FROM base AS dependencies([\s\S]*?)FROM base AS production-dependencies/,
  );
  assert.ok(dependencyStage);
  assert.match(dependencyStage[1], /COPY patches \.\/patches[\s\S]*pnpm install --frozen-lockfile/);
});

async function withHistory(run) {
  const dom = new JSDOM("", { url: `https://admin.example${entries[0]}` });
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  const history = createBrowserHistory({ window: dom.window });
  const nativeGo = dom.window.history.go.bind(dom.window.history);
  try {
    for (const href of entries.slice(1)) {
      history.push(href);
      history.flush();
    }
    const ready = nextPop(dom.window);
    nativeGo(-2);
    await ready;
    assert.equal(history.location.href, entries[2]);
    await run({ history, window: dom.window, nativeGo });
  } finally {
    history.destroy();
    globalThis.document = previousDocument;
    dom.window.close();
  }
}

for (const delta of [-2, -1, 1, 2]) {
  test(`Stay reverses browser history delta ${delta} without changing the route or entry`, async () => {
    await withHistory(async ({ history, window, nativeGo }) => {
      const original = history.location;
      const decisions = [];
      history.block({
        blockerFn: (args) => new Promise((resolve) => decisions.push({ args, resolve })),
      });
      const rollbacks = [];
      let onRollback;
      window.history.go = (value) => {
        rollbacks.push(value);
        onRollback(value);
        nativeGo(value);
      };

      // Repeat in both directions: a cancelled Forward must not leave an
      // ignore-next-pop flag that silently skips the next navigation guard.
      for (const direction of [delta, -delta, delta]) {
        const decisionCount = decisions.length;
        const attempted = nextPop(window);
        nativeGo(direction);
        await attempted;
        assert.equal(decisions.length, decisionCount + 1);
        const decision = decisions.at(-1);
        assert.equal(decision.args.currentLocation.href, original.href);
        assert.equal(decision.args.nextLocation.href, entries[2 + direction]);
        assert.equal(
          decision.args.action,
          Math.abs(direction) > 1 ? "GO" : direction < 0 ? "BACK" : "FORWARD",
        );

        const rollbackRequested = new Promise((resolve) => {
          onRollback = resolve;
        });
        const restored = nextPop(window);
        decision.resolve(true);
        assert.equal(await rollbackRequested, -direction);
        await restored;
        assert.equal(
          window.location.pathname + window.location.search + window.location.hash,
          original.href,
        );
        assert.deepEqual(window.history.state, original.state);
        assert.deepEqual(history.location, original);
        assert.equal(window.history.length, entries.length);
        assert.equal(decisions.length, decisionCount + 1);
      }
      assert.deepEqual(rollbacks, [-delta, delta, -delta]);

      // Leave after repeated Stay resolutions still completes exactly once.
      const attempted = nextPop(window);
      nativeGo(delta);
      await attempted;
      const navigated = new Promise((resolve) => {
        const unsubscribe = history.subscribe(() => {
          unsubscribe();
          resolve();
        });
      });
      decisions.at(-1).resolve(false);
      await navigated;
      assert.equal(history.location.href, entries[2 + delta]);
      assert.equal(
        window.location.pathname + window.location.search + window.location.hash,
        entries[2 + delta],
      );
      assert.equal(rollbacks.length, 3);
    });
  });
}

test("link Stay and pristine query navigation keep the browser and router in sync", async () => {
  await withHistory(async ({ history, window, nativeGo }) => {
    const original = history.location;
    let resolveBlocker;
    const unblock = history.block({
      blockerFn: () =>
        new Promise((resolve) => {
          resolveBlocker = resolve;
        }),
    });
    history.push("/admin/docs-guild/lfg");
    resolveBlocker(true);
    await Promise.resolve();
    history.flush();
    assert.deepEqual(history.location, original);
    assert.deepEqual(window.history.state, original.state);
    assert.equal(
      window.location.pathname + window.location.search + window.location.hash,
      original.href,
    );
    unblock();

    for (const delta of [1, -1, -2, 2]) {
      const navigated = nextPop(window);
      nativeGo(delta);
      await navigated;
      assert.equal(
        window.location.pathname + window.location.search + window.location.hash,
        history.location.href,
      );
    }
    history.replace("/admin/docs-guild/blocklist?workspaceId=docs-workspace&tab=blocklist");
    history.flush();
    assert.equal(window.location.search, "?workspaceId=docs-workspace&tab=blocklist");
    history.push("/admin/docs-guild/lfg?workspaceId=docs-workspace");
    history.flush();
    assert.equal(window.location.pathname + window.location.search, history.location.href);
  });
});
