import assert from "node:assert/strict";
import test from "node:test";
import { withAdminDom } from "./support/admin-dom";

test("WARDOGS dashboard shows price history and updates the scoped Discord panel", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    const { AdminWardogsCommunityPage } =
      await import("../src/admin/components/admin-wardogs-community-page");
    const panel = {
      channelId: "102",
      messageId: "600",
      title: "Link WARDOGS",
      description: "For our members.",
    };
    const writes: unknown[] = [];
    globalThis.fetch = async (_url, init) => {
      if (init?.method === "POST") {
        writes.push(JSON.parse(String(init.body)));
        return Response.json({ panel });
      }
      return Response.json({
        roles: [],
        textChannels: [{ id: "102", name: "wardogs-links" }],
        voiceChannels: [],
        categories: [],
        forumChannels: [],
      });
    };
    const today = Date.parse("2026-11-21T00:00:00Z");
    await render(
      <AdminWardogsCommunityPage
        selectedGuildId="100"
        selectedWorkspaceId="workspace-1"
        initialData={{
          enabled: true,
          canWrite: true,
          steamLinkReady: true,
          trackerConnectAvailable: true,
          goldAvailable: true,
          gold: {
            latest: { ts: today, price: 651250 },
            history: [
              { ts: today - 86400000, price: 621425 },
              { ts: today, price: 651250 },
            ],
          },
          goldChannelId: null,
          panel,
        }}
      />,
    );
    assert.match(container.textContent ?? "", /651,250.*Cash per gold bar/);
    assert.match(container.querySelector("figure")?.textContent ?? "", /20 Nov 2026.*621,425/);
    assert.match(container.textContent ?? "", /\+4\.8% vs\. yesterday/);
    assert.match(
      container.querySelector('[aria-label="Discord panel preview"]')?.textContent ?? "",
      /Link Steam.*Sync WARDOGS stats/,
    );
    await click("Update link panel");
    assert.deepEqual(writes, [
      {
        guildId: "100",
        workspaceId: "workspace-1",
        action: "publish-panel",
        channelId: "102",
        title: panel.title,
        description: panel.description,
      },
    ]);
    assert.match(container.textContent ?? "", /WARDOGS link panel published/);
    assert.ok(container.querySelector('a[href="https://discord.com/channels/100/102/600"]'));
  });
});
