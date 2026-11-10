import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { withAdminDom } from "./support/admin-dom";

test("Player Count provider selection uses Guild targets and explains experimental readiness", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    globalThis.fetch = async () =>
      Response.json({
        checksByFeature: {},
        voiceChannels: [],
        textChannels: [],
        channels: [],
        roles: [],
      });
    const { AdminPlayerCountPage } = await import("../src/admin/components/admin-playercount-page");
    await render(
      <AdminPlayerCountPage
        selectedGuildId="guild-1"
        selectedWorkspaceId="workspace-1"
        initialData={{
          guildId: "guild-1",
          servers: [],
          wardogs: {
            enabled: false,
            targets: [
              {
                id: "target-1",
                name: "Prepared target",
                ready: false,
                reason: "Read setup required",
              },
            ],
          },
        }}
      />,
    );
    await click("Add server");
    const provider = document.getElementById("pc-provider");
    assert.ok(provider instanceof window.HTMLSelectElement);
    await act(async () => {
      provider.value = "wardogs-rcon";
      provider.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    assert.equal(container.querySelector("#pc-steam-host"), null);
    assert.match(container.textContent ?? "", /Prepared target/);
    assert.match(container.textContent ?? "", /disabled by the HAF operator/);
    assert.match(container.textContent ?? "", /Unknown queue is shown as \?/);
    assert.equal(container.querySelector('input[type="password"]'), null);
    const target = document.getElementById("pc-wardogs-target");
    assert.ok(target instanceof window.HTMLSelectElement);
    await act(async () => {
      target.value = "target-1";
      target.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    assert.equal(target.value, "target-1");
  });
});
