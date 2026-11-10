/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test, { mock } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import {
  AdminMentionProtectionPage,
  describeMentionProtectionPolicy,
  hasMentionProtectionChanges,
  humanDuration,
  MentionProtectionChannelScopeFields,
  MentionProtectionEffectiveResponse,
  MentionProtectionPolicyFields,
  MentionProtectionSetupIssues,
  normalizeMentionProtectionConfig,
} from "../src/admin/components/admin-mention-protection-page";
import { createDefaultMentionProtectionConfig } from "../src/services/mention-protection/message-handler";
import { getGuildEntitlementLimits, type MentionProtectionConfig } from "../src/types";
import { resetGuildResourcesCache } from "../src/admin/lib/guild-resources-cache";
import type { EntitlementInfo } from "../src/admin/hooks/use-entitlement";

test("Mention Protection hides successful setup checks and shows only actionable issues", () => {
  const readyHtml = renderToStaticMarkup(
    <MentionProtectionSetupIssues
      checks={[
        { id: "channel-permissions", label: "Channel permissions", status: "ok", detail: "Ready." },
      ]}
    />,
  );
  const issueHtml = renderToStaticMarkup(
    <MentionProtectionSetupIssues
      checks={[
        { id: "channel-permissions", label: "Channel permissions", status: "ok", detail: "Ready." },
        {
          id: "timed-role-hierarchy",
          label: "Timed Role hierarchy",
          status: "error",
          detail: "Move the bot role.",
        },
      ]}
    />,
  );

  assert.equal(readyHtml, "");
  assert.doesNotMatch(issueHtml, /Channel permissions/);
  assert.match(issueHtml, /Fix: Timed Role hierarchy/);
});

test("Mention Protection channel scope uses the Reaction Rules include/exclude toggle", () => {
  const html = renderToStaticMarkup(
    <MentionProtectionChannelScopeFields
      mode="exclude"
      channelIds={["channel-1"]}
      channels={[{ id: "channel-1", name: "general" }]}
      onModeChange={() => {}}
      onChannelIdsChange={() => {}}
    />,
  );

  assert.match(html, />Include</);
  assert.match(html, />Exclude</);
  assert.match(html, /Selected channels are excluded; all other channels are protected/);
  assert.doesNotMatch(html, /mp-channel-mode/);
});

test("Mention Protection marks a channel mode change as unsaved", () => {
  const saved = normalizeMentionProtectionConfig(
    createDefaultMentionProtectionConfig("guild-1", 0),
  );
  const current = { ...saved, channelMode: "include" as const };

  assert.equal(hasMentionProtectionChanges(saved, saved), false);
  assert.equal(hasMentionProtectionChanges(current, saved), true);
});

test("Mention Protection Timed Role policy reveals role and duration controls instead of timeout controls", () => {
  const html = renderToStaticMarkup(
    <MentionProtectionPolicyFields
      idPrefix="spam-repeat"
      label="Repeat response"
      policy={{
        reply: true,
        delete: true,
        restriction: { type: "timed-role", roleId: "restricted-role", durationMs: 3_600_000 },
      }}
      roles={[{ id: "restricted-role", name: "Restricted" }]}
      onChange={() => {}}
    />,
  );

  assert.equal(html.match(/role="combobox"/g)?.length, 2);
  assert.equal(html.match(/role="checkbox"/g)?.length, 2);
  assert.match(html, /Restriction role/);
  assert.match(html, /Duration \(minutes\)/);
  assert.doesNotMatch(html, /Timeout duration/);
});

test("Free Mention Protection keeps warning and deletion controls active while disabling restrictions", () => {
  const html = renderToStaticMarkup(
    <MentionProtectionPolicyFields
      idPrefix="admin-repeat"
      label="Repeat response"
      policy={{
        reply: true,
        delete: true,
        restriction: { type: "timeout", durationMs: 600_000 },
      }}
      roles={[]}
      paidRestrictionsAvailable={false}
      onChange={() => {}}
    />,
  );

  assert.match(html, /Discord timeout and Timed Role restrictions require a paid plan/);
  assert.match(
    html,
    /(?:admin-repeat-restriction[^>]*disabled=""|disabled=""[^>]*admin-repeat-restriction)/,
  );
  assert.match(html, /admin-repeat-timeout-duration[^>]*disabled=""/);
  assert.equal(html.match(/role="checkbox"[^>]*disabled=""/g), null);
});

test("Mention Protection effective response humanises actions, durations, roles, and dormant restrictions", () => {
  const roles = new Map([["restricted", "Restricted"]]);
  assert.equal(
    describeMentionProtectionPolicy(
      {
        reply: true,
        delete: true,
        restriction: { type: "timed-role", roleId: "restricted", durationMs: 3_600_000 },
      },
      roles,
      true,
    ),
    "Reply with a warning, delete the message and assign @Restricted for 1 hour.",
  );
  assert.equal(
    describeMentionProtectionPolicy(
      {
        reply: false,
        delete: false,
        restriction: { type: "timeout", durationMs: 600_000 },
      },
      roles,
      false,
    ),
    "Skip the retained paid restriction on the current plan.",
  );
  assert.equal(humanDuration(5 * 60_000), "5 minutes");
  assert.equal(humanDuration(2 * 3_600_000), "2 hours");
});

test("fresh Admin Mention Protection defaults warn and delete without an implicit paid restriction", () => {
  const config = normalizeMentionProtectionConfig(null);
  assert.deepEqual(config.adminInitialResponse, {
    reply: true,
    delete: true,
    restriction: { type: "none" },
  });
  assert.deepEqual(config.adminRepeatResponse, config.adminInitialResponse);
});

test("effective-response equality follows current-plan actions and ignores object key order", () => {
  const initial = { reply: true, delete: true, restriction: { type: "none" as const } };
  const repeat = {
    restriction: { type: "timeout" as const, durationMs: 600_000 },
    delete: true,
    reply: true,
  };
  const render = (paid: boolean, repeatPolicy = repeat) =>
    renderToStaticMarkup(
      <MentionProtectionEffectiveResponse
        initialPolicy={initial}
        repeatPolicy={repeatPolicy}
        repeatPeriodMs={86_400_000}
        roles={[]}
        paidRestrictionsAvailable={paid}
      />,
    );
  assert.match(render(false), /identical on the current plan/);
  assert.match(render(false), /skip the retained paid restriction/);
  assert.doesNotMatch(render(true), /identical/);
  assert.doesNotMatch(render(false, { ...repeat, delete: false }), /identical/);
  assert.doesNotMatch(render(false, { ...repeat, reply: false }), /identical/);

  const reordered = renderToStaticMarkup(
    <MentionProtectionEffectiveResponse
      initialPolicy={repeat}
      repeatPolicy={{
        reply: true,
        delete: true,
        restriction: { durationMs: 600_000, type: "timeout" },
      }}
      repeatPeriodMs={86_400_000}
      roles={[]}
      paidRestrictionsAvailable
    />,
  );
  assert.match(reordered, /identical on the current plan/);
});

test("timeout preset is marked paid and disabled on Free or unknown entitlement, and works on paid plans", async () => {
  for (const tier of ["free", null, "premium", "premium_plus"] as const) {
    const config = createDefaultMentionProtectionConfig("guild-1", 0);
    config.adminEnabled = true;
    config.protectedAdminRoleIds = ["admin-role"];
    config.adminInitialResponse = { reply: false, delete: false, restriction: { type: "none" } };
    config.adminRepeatResponse = { ...config.adminInitialResponse };
    await withMentionProtectionPage(config, tier, async ({ container, saved, click }) => {
      const button = findButton(container, "Escalate to timeout on repeat (paid)");
      assert.equal(button.disabled, tier === "free" || tier === null);
      await act(async () => button.click());
      if (button.disabled) {
        assert.equal(findButton(container, "Save changes").disabled, true);
        assert.doesNotMatch(container.textContent ?? "", /apply a 10 minutes Discord timeout/);
      } else {
        assert.match(container.textContent ?? "", /apply a 10 minutes Discord timeout/);
        await click("Save changes");
        assert.equal(saved.length, 1);
        assert.deepEqual(saved[0].adminRepeatResponse.restriction, {
          type: "timeout",
          durationMs: 600_000,
        });
      }
    });
  }
});

test("Free presets preserve distinct retained restrictions through save, reload, and upgrade", async () => {
  const config = createDefaultMentionProtectionConfig("guild-1", 0);
  config.adminEnabled = true;
  config.protectedAdminRoleIds = ["admin-role"];
  config.adminInitialResponse.restriction = {
    type: "timed-role",
    roleId: "restricted-role",
    durationMs: 3_600_000,
  };
  config.adminRepeatResponse.restriction = { type: "timeout", durationMs: 600_000 };
  await withMentionProtectionPage(config, "free", async ({ container, saved, click, reload }) => {
    assert.match(container.textContent ?? "", /identical on the current plan/);
    await click("Warn only");
    assert.match(container.textContent ?? "", /retained paid restrictions stay unchanged/);
    assert.match(container.textContent ?? "", /skip the retained paid restriction/);
    await click("Save changes");
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].adminInitialResponse, {
      ...config.adminInitialResponse,
      delete: false,
    });
    assert.deepEqual(saved[0].adminRepeatResponse, {
      ...config.adminRepeatResponse,
      delete: false,
    });
    await reload(saved[0], "free");
    assert.match(container.textContent ?? "", /skip the retained paid restriction/);
    assert.match(container.textContent ?? "", /identical on the current plan/);
    await reload(saved[0], "premium");
    assert.doesNotMatch(container.textContent ?? "", /skip the retained paid restriction/);
    assert.doesNotMatch(container.textContent ?? "", /identical on the current plan/);
    assert.match(container.textContent ?? "", /assign @Restricted for 1 hour/);
    assert.match(container.textContent ?? "", /apply a 10 minutes Discord timeout/);
  });
});

function findButton(
  container: Pick<ParentNode, "querySelectorAll">,
  text: string,
): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === text,
  );
  assert.ok(button, `Missing button: ${text}`);
  return button;
}

async function withMentionProtectionPage(
  config: MentionProtectionConfig,
  tier: EntitlementInfo["tier"] | null,
  run: (page: {
    container: HTMLElement;
    saved: MentionProtectionConfig[];
    click: (text: string, scope?: Pick<ParentNode, "querySelectorAll">) => Promise<void>;
    reload: (config: MentionProtectionConfig, tier: EntitlementInfo["tier"]) => Promise<void>;
  }) => Promise<void>,
) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "https://example.test/admin/guild-1/mention-protection",
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    fetch: globalThis.fetch,
  };
  const reactEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = reactEnv.IS_REACT_ACT_ENVIRONMENT;
  reactEnv.IS_REACT_ACT_ENVIRONMENT = true;
  const saved: MentionProtectionConfig[] = [];
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle,
    fetch: async (input: string, init?: RequestInit) => {
      const url = new URL(input, "https://example.test");
      if (url.pathname === "/admin/api/tickets/resources")
        return Response.json({
          guildId: "guild-1",
          roles: [
            { id: "admin-role", name: "Admin" },
            { id: "restricted-role", name: "Restricted" },
          ],
          textChannels: [],
          forumChannels: [],
        });
      if (url.pathname === "/admin/api/permissions/diagnostics")
        return Response.json({ checksByFeature: { "mention-protection": [] } });
      if (url.pathname === "/admin/api/configuration-revisions")
        return Response.json({ revisions: [], nextCursor: null });
      if (url.pathname === "/admin/api/mention-protection/config" && init?.method === "POST") {
        const value = JSON.parse(String(init.body)) as MentionProtectionConfig;
        const stored = { ...config, ...value };
        saved.push(stored);
        return Response.json({ guildId: "guild-1", config: stored });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    },
  });
  resetGuildResourcesCache();
  const container = document.querySelector<HTMLElement>("#root");
  assert.ok(container);
  const root = createRoot(container);
  // Accept replacement confirmation without depending on Radix's browser-only portal lifecycle.
  const confirmDialog =
    require("../src/admin/components/ui/confirm-dialog") as typeof import("../src/admin/components/ui/confirm-dialog");
  const confirmation = mock.method(confirmDialog, "useConfirmDialog", () => ({
    dialog: null,
    confirm: async () => true,
  }));
  let generation = 0;
  async function render(config: MentionProtectionConfig, tier: EntitlementInfo["tier"] | null) {
    const entitlement: EntitlementInfo | null = tier
      ? {
          tier,
          limits: getGuildEntitlementLimits(tier),
          supportInvite: null,
          r2Usage: { usedBytes: 0, reservedBytes: 0, maxBytes: 0, lastReconciledAtMs: null },
        }
      : null;
    await act(async () =>
      root.render(
        <AdminMentionProtectionPage
          key={generation++}
          selectedWorkspaceId=""
          selectedGuildId="guild-1"
          entitlement={entitlement}
          initialData={{ guildId: "guild-1", config, entitlement, setupChecks: [] }}
          onRouteDataRefresh={async () => {}}
        />,
      ),
    );
  }
  try {
    await render(config, tier);
    await run({
      container,
      saved,
      click: async (text, scope = container) => {
        await act(async () => findButton(scope, text).click());
      },
      reload: render,
    });
  } finally {
    await act(async () => root.unmount());
    confirmation.mock.restore();
    resetGuildResourcesCache();
    Object.assign(globalThis, previous);
    reactEnv.IS_REACT_ACT_ENVIRONMENT = previousAct;
    dom.window.close();
  }
}
