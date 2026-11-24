import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { DEFAULT_GOLD_VOICE_FORMAT } from "../src/wardogs/gold-status";
import { withAdminDom } from "./support/admin-dom";

test("WARDOGS dashboard shows price history and saves its Discord channels and panel", async (t) => {
  await withAdminDom(async ({ render, click, container }) => {
    const previousEvent = globalThis.Event;
    globalThis.Event = window.Event;
    t.after(() => {
      globalThis.Event = previousEvent;
    });
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
        const body = JSON.parse(String(init.body));
        writes.push(body);
        if (body.action === "gold")
          return Response.json({
            goldChannelId: null,
            goldVoiceChannelId: "111",
            goldVoiceFormat: body.voiceFormat,
            goldPostFormat: body.postFormat,
          });
        return Response.json({ panel });
      }
      return Response.json({
        roles: [],
        textChannels: [{ id: "102", name: "wardogs-links" }],
        voiceChannels: [{ id: "111", name: "Gold Exchange" }],
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
          goldVoiceChannelId: null,
          goldVoiceFormat: DEFAULT_GOLD_VOICE_FORMAT,
          goldPostFormat: "full",
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

    const select = container.querySelector("#wardogs-gold-voice-channel");
    assert.ok(select);
    const enter = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    await act(async () => select.dispatchEvent(enter));
    const options = [...document.querySelectorAll('[role="option"]')];
    const voice = options.find((option) => option.textContent?.includes("Gold Exchange"));
    assert.ok(voice);
    assert.ok(!options.some((option) => option.textContent?.includes("wardogs-links")));
    await act(async () =>
      voice.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    const format = container.querySelector("#wardogs-gold-post-format");
    assert.ok(format instanceof window.HTMLSelectElement);
    await act(async () => {
      format.value = "image";
      format.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    const voiceFormat = "{price}";
    const input = container.querySelector<HTMLInputElement>("#wardogs-gold-voice-format");
    assert.ok(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
        input,
        voiceFormat,
      );
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.equal(
      [...container.querySelectorAll("p")].find((p) => p.textContent?.startsWith("Preview ·"))
        ?.textContent,
      "Preview · 651,250",
    );
    await click("Save daily updates");
    assert.deepEqual(writes.at(-1), {
      guildId: "100",
      workspaceId: "workspace-1",
      action: "gold",
      voiceChannelId: "111",
      voiceFormat,
      postFormat: "image",
    });
    assert.match(container.textContent ?? "", /Price display in Gold Exchange/);
  });
});
