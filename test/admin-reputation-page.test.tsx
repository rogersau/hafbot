import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { withAdminDom } from "./support/admin-dom";
import { defaultReputationConfig } from "../src/reputation/types";

test("Reputation dashboard saves the selected Guild and workspace with an optimistic revision", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    const { AdminReputationPage } = await import("../src/admin/components/admin-reputation-page");
    const config = { ...defaultReputationConfig("100"), revision: 3 };
    const calls: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      if (!init?.method)
        return Response.json({
          roles: [],
          categories: [],
          textChannels: [],
          voiceChannels: [],
          forumChannels: [],
        });
      const body = JSON.parse(String(init.body));
      calls.push(body);
      return Response.json({ config: { ...config, ...body.settings, revision: 4 } });
    };
    await render(
      <AdminReputationPage
        selectedGuildId="100"
        selectedWorkspaceId="workspace-a"
        initialData={{ guildId: "100", config }}
      />,
    );
    const toggle = container.querySelector<HTMLButtonElement>("#reputation-enabled")!;
    await act(async () => toggle.click());
    await click("Save settings");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.guildId, "100");
    assert.equal(calls[0]?.workspaceId, "workspace-a");
    assert.equal(calls[0]?.expectedRevision, 3);
    assert.equal((calls[0]!.settings as { enabled: boolean }).enabled, true);
    assert.match(container.textContent ?? "", /Reputation settings saved/);
  });
});

test("Reputation dashboard retains edits and displays a revision conflict without claiming success", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    const { AdminReputationPage } = await import("../src/admin/components/admin-reputation-page");
    globalThis.fetch = async (_input, init) =>
      !init?.method
        ? Response.json({
            roles: [],
            categories: [],
            textChannels: [],
            voiceChannels: [],
            forumChannels: [],
          })
        : Response.json({ error: "Settings changed. Reload the page." }, { status: 409 });
    await render(
      <AdminReputationPage
        selectedGuildId="100"
        selectedWorkspaceId="workspace-a"
        initialData={{ guildId: "100", config: defaultReputationConfig("100") }}
      />,
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>("#reputation-enabled")!.click(),
    );
    await click("Save settings");
    assert.match(container.textContent ?? "", /Settings changed/);
    assert.match(container.textContent ?? "", /Unsaved changes/);
    assert.doesNotMatch(container.textContent ?? "", /settings saved/);
  });
});
