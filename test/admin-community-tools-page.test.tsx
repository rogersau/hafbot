import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { withAdminDom } from "./support/admin-dom";
import { automationConfigSchema } from "../src/community-tools/config";

test("automation dashboard saves server settings with the selected workspace and revision", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    const { AdminAutomationPage } =
      await import("../src/admin/components/admin-community-tools-page");
    const config = automationConfigSchema.parse({});
    const writes: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_input, init) => {
      if (!init?.method)
        return Response.json({
          roles: [],
          textChannels: [],
          voiceChannels: [],
          categories: [],
          forumChannels: [],
        });
      const body = JSON.parse(String(init.body));
      writes.push(body);
      return Response.json({ config: body.config, revision: 4 });
    };
    await render(
      <AdminAutomationPage
        selectedGuildId="100"
        selectedWorkspaceId="workspace-a"
        initialData={{ guildId: "100", config, revision: 3, twitchAvailable: false }}
      />,
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Enable Custom Replies and Schedules"]')!
        .click(),
    );
    await click("Save settings");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].guildId, "100");
    assert.equal(writes[0].workspaceId, "workspace-a");
    assert.equal(writes[0].revision, 3);
    assert.equal((writes[0].config as { enabled: boolean }).enabled, true);
    assert.match(container.textContent ?? "", /Settings saved/);
  });
});
test("automation dashboard preserves unsaved settings when a concurrent edit rejects the save", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    const { AdminAutomationPage } =
      await import("../src/admin/components/admin-community-tools-page");
    globalThis.fetch = async (_input, init) =>
      !init?.method
        ? Response.json({
            roles: [],
            textChannels: [],
            voiceChannels: [],
            categories: [],
            forumChannels: [],
          })
        : Response.json({ error: "These settings changed. Refresh the page." }, { status: 409 });
    await render(
      <AdminAutomationPage
        selectedGuildId="100"
        selectedWorkspaceId="workspace-b"
        initialData={{
          guildId: "100",
          config: automationConfigSchema.parse({}),
          revision: 1,
          twitchAvailable: false,
        }}
      />,
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Enable Custom Replies and Schedules"]')!
        .click(),
    );
    await click("Save settings");
    assert.match(container.textContent ?? "", /settings changed/);
    assert.doesNotMatch(container.textContent ?? "", /Settings saved/);
    assert.equal(
      container
        .querySelector('[aria-label="Enable Custom Replies and Schedules"]')
        ?.getAttribute("aria-checked"),
      "true",
    );
  });
});
