import { adminErrorResponse } from "./support/admin-error-response";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { withAdminDom } from "./support/admin-dom";
import { changeValue } from "./support/admin-dom-events";
import { defaultBanAppealConfig, type BanAppeal } from "../src/moderation-appeals/types";

const appeal: BanAppeal = {
  id: "07db2e13-e7dc-43a0-8082-b214022d2a12",
  guildId: "100",
  userId: "101",
  displayName: "Appellant",
  text: "Please review the Discord server ban.",
  banReason: "Staff evidence",
  status: "pending",
  revision: 1,
  createdAtMs: 1_000,
  resolvedAtMs: null,
  reviewerUserId: null,
  decisionReason: null,
  operationId: null,
};

test("Ban appeals panel saves explicit Guild-scoped configuration with its current revision", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    const { AdminBanAppealsPanel } =
      await import("../src/admin/components/admin-ban-appeals-panel");
    const config = defaultBanAppealConfig("100");
    const mutations: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      if (!init?.method) return Response.json({ guildId: "100", config, appeals: [] });
      const body = JSON.parse(String(init.body));
      mutations.push(body);
      return Response.json({ config: { ...config, ...body.settings, revision: 1 } });
    };
    await render(<AdminBanAppealsPanel selectedGuildId="100" selectedWorkspaceId="workspace-a" />);
    await act(async () =>
      container.querySelector<HTMLButtonElement>("#ban-appeals-enabled")!.click(),
    );
    await click("Save appeal settings");
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0]?.guildId, "100");
    assert.equal(mutations[0]?.workspaceId, "workspace-a");
    assert.equal(mutations[0]?.expectedRevision, 0);
    assert.match(container.textContent ?? "", /Ban appeal settings saved/);
    assert.equal(
      container.querySelector<HTMLAnchorElement>('a[href="/ban-appeals/100"]')?.textContent,
      "Open public appeal page",
    );
  });
});

test("Ban appeals panel confirms explicit unban actions and shows an uncertain result without claiming success", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    const { AdminBanAppealsPanel } =
      await import("../src/admin/components/admin-ban-appeals-panel");
    let current = { ...appeal };
    const mutations: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      if (!init?.method)
        return path.includes("/detail")
          ? Response.json({ appeal: current, operations: [] })
          : Response.json({
              guildId: "100",
              config: defaultBanAppealConfig("100"),
              appeals: [current],
            });
      const body = JSON.parse(String(init.body));
      mutations.push({ path, body });
      current = { ...current, status: "unban_pending", revision: 3 };
      return adminErrorResponse(
        "The unban result could not be confirmed. Refresh and check its status.",
        409,
      );
    };
    await render(<AdminBanAppealsPanel selectedGuildId="100" selectedWorkspaceId="workspace-a" />);
    await click("Appellant · Awaiting review");
    await act(async () =>
      changeValue(
        container.querySelector<HTMLTextAreaElement>("#ban-appeals-review-reason")!,
        "Staff reviewed the ban and approved this appeal",
      ),
    );
    await click("Approve and unban");
    assert.equal(mutations.length, 0);
    await click("Unban member");
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0]?.body.action, "unban");
    assert.equal(mutations[0]?.body.expectedRevision, 1);
    assert.match(container.textContent ?? "", /could not be confirmed/);
    assert.match(container.textContent ?? "", /Check unban result/);
    assert.doesNotMatch(container.textContent ?? "", /ban removal confirmed/);
  });
});
