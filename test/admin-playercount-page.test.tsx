/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Tests compile via tsconfig.tests.json; admin React is excluded from the runtime test build.
import test from "node:test";
import { renderToString } from "react-dom/server";

import {
  AdminPlayerCountPage,
  formatPlayerCountAge,
  formatPlayerCountTimestamp,
  getPlayerCountStatus,
  playerCountChannelLabel,
} from "../src/admin/components/admin-playercount-page";
import type { PlayerCountServer } from "../src/types/player-count";
import type { PlayerCountLoaderData } from "../src/admin/lib/admin-route-loaders";

function buildServer(overrides: Partial<PlayerCountServer> = {}): PlayerCountServer {
  return {
    id: "server-1",
    guildId: "guild-1",
    name: "Main PvP",
    provider: "steam-web",
    providerServerId: "1.2.3.4:27015",
    channelId: null,
    alertChannelId: null,
    refreshIntervalMinutes: 10,
    displayFormat: "Players {count}/{max}",
    offlineFormat: "Players Offline",
    failureThreshold: 3,
    renameOffsetMinutes: 0,
    lastRenamedAtMs: null,
    lastPlayerCount: 12,
    lastMaxSlots: 60,
    lastQueueSize: 0,
    lastFetchedAtMs: Date.now() - 5 * 60 * 1000,
    consecutiveFailureCount: 0,
    lastErrorMessage: null,
    lastErrorAtMs: null,
    steamHost: "1.2.3.4",
    steamPort: 27015,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

function buildInitialData(servers: PlayerCountServer[]): PlayerCountLoaderData {
  return { guildId: "guild-1", servers };
}

function renderPage(initialData: PlayerCountLoaderData | null) {
  return renderToString(
    <AdminPlayerCountPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={initialData}
    />,
  );
}

test("AdminPlayerCountPage renders the OK status for a healthy server", () => {
  const html = renderPage(buildInitialData([buildServer()]));

  assert.match(html, /OK/);
  assert.doesNotMatch(html, /Error · 3× in a row/);
});

test("AdminPlayerCountPage renders the error badge and message when the server has a failure streak", () => {
  const html = renderPage(
    buildInitialData([
      buildServer({
        consecutiveFailureCount: 3,
        lastErrorMessage: "Server 1.2.3.4:27015 not found in Steam directory",
        lastErrorAtMs: Date.now() - 60 * 1000,
      }),
    ]),
  );

  assert.match(html, /Error/);
  assert.match(html, /3/);
  assert.match(html, /× in a row/);
  assert.match(html, /Server 1\.2\.3\.4:27015 not found in Steam directory/);
});

test("AdminPlayerCountPage renders a Test button for each configured server", () => {
  const html = renderPage(
    buildInitialData([
      buildServer({ id: "server-1", name: "Main PvP" }),
      buildServer({ id: "server-2", name: "EU PvE" }),
    ]),
  );

  const matches = html.match(/Testing…|Test<\/button>|>Test</g) ?? [];
  assert.ok(matches.length >= 2, `expected at least 2 Test buttons, got ${matches.length}`);
});

test("Player Count status derives failures, stale data, and never-checked records", () => {
  const now = 1_000_000;
  assert.equal(getPlayerCountStatus(buildServer({ lastFetchedAtMs: now - 1_000 }), now), "recent");
  assert.equal(
    getPlayerCountStatus(
      buildServer({ lastFetchedAtMs: now - 11 * 60_000, refreshIntervalMinutes: 10 }),
      now,
    ),
    "stale",
  );
  assert.equal(getPlayerCountStatus(buildServer({ lastFetchedAtMs: null }), now), "never-checked");
  assert.equal(
    getPlayerCountStatus(buildServer({ consecutiveFailureCount: 1, lastFetchedAtMs: now }), now),
    "needs-attention",
  );
});

test("Player Count presents channel fallbacks and exact query time", () => {
  assert.equal(playerCountChannelLabel(null, []), "Not configured");
  assert.equal(playerCountChannelLabel("missing", []), "Unavailable channel · missing");
  assert.equal(
    playerCountChannelLabel("voice-1", [{ id: "voice-1", name: "players" }]),
    "#players",
  );
  const timestamp = 1_700_000_000_000;
  assert.equal(formatPlayerCountAge(timestamp, timestamp + 2 * 60_000), "2m ago");
  assert.match(formatPlayerCountTimestamp(timestamp), /2023/);
});

test("Player Count renders responsive status, destinations, and stored snapshot details", () => {
  const html = renderPage(
    buildInitialData([
      buildServer({
        id: "attention",
        name: "Attention Server",
        consecutiveFailureCount: 2,
        lastErrorMessage: "Query timed out",
        channelId: "voice-missing",
        alertChannelId: "alert-missing",
      }),
      buildServer({ id: "recent", name: "Recent Server" }),
    ]),
  );

  assert.match(html, /data-responsive-table/);
  assert.match(html, /Needs attention/);
  assert.match(html, /Unavailable channel · voice-missing/);
  assert.match(html, /Current players[\s\S]*12/);
  assert.ok(html.indexOf("Attention Server") < html.indexOf("Recent Server"));
});

test("WARDOGS snapshots display unavailable queue and safe target readiness", () => {
  const html = renderPage(
    buildInitialData([
      buildServer({
        provider: "wardogs-rcon",
        providerServerId: "target-1",
        steamHost: null,
        steamPort: null,
        lastQueueSize: null,
        readiness: "dormant",
        readinessMessage: "WARDOGS target requires approved read access.",
      }),
    ]),
  );
  assert.match(html, /Unavailable/);
  assert.match(html, /WARDOGS target/);
  assert.match(html, /approved read access/);
  assert.equal(getPlayerCountStatus(buildServer({ readiness: "dormant" })), "stale");
});
