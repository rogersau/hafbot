import { adminErrorResponse } from "./support/admin-error-response";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { withAdminDom } from "./support/admin-dom";
import { changeValue } from "./support/admin-dom-events";
import { automationConfigSchema, moderationConfigSchema } from "../src/community-tools/config";
import { defaultBanAppealConfig } from "../src/moderation-appeals/types";

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
        : adminErrorResponse("These settings changed. Refresh the page.", 409);
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

test("chat moderation discloses third-party processing and saves the AI spam threshold", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    const { AdminChatModerationPage } =
      await import("../src/admin/components/admin-community-tools-page");
    const config = moderationConfigSchema.parse({});
    const writes: Array<{ config: typeof config }> = [];
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("/admin/api/ban-appeals"))
        return Response.json({
          guildId: "100",
          config: defaultBanAppealConfig("100"),
          appeals: [],
        });
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
      return Response.json({ config: body.config, revision: 1 });
    };
    await render(
      <AdminChatModerationPage
        selectedGuildId="100"
        selectedWorkspaceId="workspace-a"
        initialData={{ guildId: "100", config, revision: 0, twitchAvailable: false }}
      />,
    );
    await click("Add moderation rule");
    const trigger = container.querySelector('select[id^="moderation-trigger-"]');
    assert.ok(trigger);
    assert.equal(trigger.querySelector("option:checked")?.getAttribute("value"), "invites");
    assert.equal(trigger.hasAttribute("aria-describedby"), false);
    const thresholdSelector = 'input[id^="moderation-spam-threshold-"]';
    assert.equal(container.querySelector(thresholdSelector), null);

    await act(async () => changeValue(trigger, "ai_spam"));
    const noticeId = trigger.getAttribute("aria-describedby");
    assert.ok(noticeId);
    assert.match(
      document.getElementById(noticeId)?.textContent ?? "",
      /sends eligible Discord message text to the third-party AI provider/,
    );
    const threshold = container.querySelector<HTMLInputElement>(thresholdSelector);
    assert.ok(threshold);
    assert.match(threshold.labels?.[0]?.textContent ?? "", /Spam probability threshold \(90%\)/);
    assert.equal(threshold.getAttribute("aria-valuetext"), "90%");
    await act(async () => changeValue(threshold, "0.8"));
    assert.equal(threshold.getAttribute("aria-valuetext"), "80%");
    assert.equal(
      container.querySelector('[aria-label="Enable rule 1"]')?.getAttribute("aria-checked"),
      "false",
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Enable Chat Moderation"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Enable rule 1"]')!.click();
    });
    await click("Save settings");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].config.enabled, true);
    assert.equal(writes[0].config.rules[0].trigger, "ai_spam");
    assert.equal(writes[0].config.rules[0].enabled, true);
    assert.equal(writes[0].config.rules[0].spamProbabilityThreshold, 0.8);
  });
});
