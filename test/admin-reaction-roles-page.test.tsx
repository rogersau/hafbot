import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { withAdminDom } from "./support/admin-dom";
import { isPublishedReactionRoleOption, type ReactionRolePanel } from "../src/reaction-roles";

const panel: ReactionRolePanel = {
  guildId: "100",
  id: "panel",
  botUserId: "900",
  channelId: "200",
  messageId: null,
  publishedOptions: [],
  activatedAtMs: null,
  enabled: false,
  updatedAtMs: 1,
  title: "Choose your games",
  description: "React to unlock game channels.",
  options: [{ emoji: "🟢", roleId: "300", label: "DayZ" }],
};

test("Reaction Roles switches between saved panels and scopes publishing to the selected panel", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    const { AdminReactionRolesPage } =
      await import("../src/admin/components/admin-reaction-roles-page");
    const second: ReactionRolePanel = {
      ...panel,
      id: "region-panel",
      title: "Regions",
      mode: "single",
      requiredRoleIds: ["410"],
      blockedRoleIds: ["411"],
      options: [{ emoji: "🟠", roleId: "301", label: "Europe" }],
    };
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      if (!init?.method)
        return Response.json({
          roles: [
            { id: "300", name: "DayZ" },
            { id: "301", name: "Europe" },
            { id: "410", name: "Member" },
            { id: "411", name: "Restricted" },
          ],
          textChannels: [{ id: "200", name: "welcome" }],
          categories: [],
          voiceChannels: [],
          forumChannels: [],
          emojis: [],
        });
      const body = JSON.parse(String(init.body));
      calls.push({ path: String(input), body });
      return Response.json({
        panel: String(input).endsWith("/publish")
          ? { ...second, messageId: "501", enabled: true }
          : second,
        panels: [panel, second],
      });
    };
    await render(
      <AdminReactionRolesPage
        selectedGuildId="100"
        selectedWorkspaceId="workspace-1"
        initialData={{ panel, panels: [panel, second] }}
      />,
    );
    await click("Edit Regions");
    assert.equal(
      container.querySelector<HTMLInputElement>("#reaction-role-title")?.value,
      "Regions",
    );
    assert.equal(
      (container.querySelector("#reaction-role-mode") as unknown as { value: string } | null)
        ?.value,
      "single",
    );
    await click("Save and publish");
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.body.panelId === second.id));
    const settings = calls[0].body.settings as {
      mode: string;
      requiredRoleIds: string[];
      blockedRoleIds: string[];
    };
    assert.equal(settings.mode, "single");
    assert.deepEqual(settings.requiredRoleIds, ["410"]);
    assert.deepEqual(settings.blockedRoleIds, ["411"]);
    await click("New panel");
    assert.match(container.textContent ?? "", /New role panel/);
    assert.equal(
      container.querySelector<HTMLInputElement>("#reaction-role-title")?.value,
      "Choose your games",
    );
    assert.equal(container.querySelector("a[href$='/501']"), null);
  });
});

test("Reaction Roles saves and publishes with guild/workspace scope and shows a usable preview", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    const { AdminReactionRolesPage } =
      await import("../src/admin/components/admin-reaction-roles-page");
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      if (!init?.method)
        return Response.json({
          guildId: "100",
          roles: [{ id: "300", name: "DayZ" }],
          textChannels: [{ id: "200", name: "welcome" }],
          categories: [],
          voiceChannels: [],
          forumChannels: [],
          emojis: [],
        });
      const body = JSON.parse(String(init.body));
      calls.push({ path, body });
      return Response.json({
        panel: path.endsWith("/publish") ? { ...panel, messageId: "500", enabled: true } : panel,
      });
    };
    await render(
      <AdminReactionRolesPage
        selectedGuildId="100"
        selectedWorkspaceId="workspace-1"
        initialData={{ panel }}
      />,
    );
    assert.match(container.textContent ?? "", /Message preview/);
    assert.match(container.textContent ?? "", /DayZ/);
    await click("Save and publish");
    assert.deepEqual(
      calls.map((call) => call.path),
      ["/admin/api/reaction-roles", "/admin/api/reaction-roles/publish"],
    );
    for (const call of calls) {
      assert.equal(call.body.guildId, "100");
      assert.equal(call.body.workspaceId, "workspace-1");
    }
    assert.match(container.textContent ?? "", /Active/);
    assert.equal(
      container.querySelector('a[href="https://discord.com/channels/100/200/500"]')?.textContent,
      "View in Discord",
    );
  });
});

test("Reaction Roles retains a saved draft and displays a publish failure so it can be retried", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    const { AdminReactionRolesPage } =
      await import("../src/admin/components/admin-reaction-roles-page");
    globalThis.fetch = async (input, init) => {
      if (!init?.method)
        return Response.json({
          roles: [],
          textChannels: [],
          categories: [],
          voiceChannels: [],
          forumChannels: [],
        });
      return String(input).endsWith("/publish")
        ? Response.json({ error: "Check the bot's Add Reactions permission." }, { status: 409 })
        : Response.json({ panel });
    };
    await render(
      <AdminReactionRolesPage
        selectedGuildId="100"
        selectedWorkspaceId="workspace-1"
        initialData={{ panel }}
      />,
    );
    await click("Save and publish");
    assert.match(container.textContent ?? "", /Add Reactions permission/);
    assert.match(container.textContent ?? "", /Draft — not published/);
    assert.ok(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Save and publish" && !button.disabled,
      ),
    );
  });
});

test("incomplete added choices show validation feedback for both save actions", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    const { AdminReactionRolesPage } =
      await import("../src/admin/components/admin-reaction-roles-page");
    let mutations = 0;
    globalThis.fetch = async (_input, init) => {
      if (init?.method) mutations++;
      return Response.json({
        roles: [],
        textChannels: [],
        categories: [],
        voiceChannels: [],
        forumChannels: [],
      });
    };
    await render(
      <AdminReactionRolesPage
        selectedGuildId="100"
        selectedWorkspaceId="workspace-1"
        initialData={{ panel }}
      />,
    );
    await click("Add role choice");
    for (const label of ["Save draft", "Save and publish"]) {
      await click(label);
      assert.match(
        container.querySelector('[role="alert"]')?.textContent ?? "",
        /emoji|string|character/i,
      );
      assert.equal(mutations, 0);
    }
  });
});

test("unpublished choices in a saved draft remain editable beside locked published choices", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    const { AdminReactionRolesPage } =
      await import("../src/admin/components/admin-reaction-roles-page");
    globalThis.fetch = async () =>
      Response.json({
        roles: [],
        textChannels: [],
        categories: [],
        voiceChannels: [],
        forumChannels: [],
      });
    const published = panel.options[0];
    await render(
      <AdminReactionRolesPage
        selectedGuildId="100"
        selectedWorkspaceId="workspace-1"
        initialData={{
          panel: {
            ...panel,
            messageId: "500",
            publishedOptions: [published],
            options: [published, { emoji: "🔵", roleId: "301", label: "Rust draft" }],
          },
        }}
      />,
    );
    assert.equal(container.querySelector<HTMLButtonElement>("#reaction-role-0")?.disabled, true);
    assert.equal(container.querySelector<HTMLButtonElement>("#reaction-role-1")?.disabled, false);
    await click("Remove choice 2");
    assert.equal(container.querySelectorAll("fieldset").length, 1);
  });
});

test("selecting a published role in an incomplete new choice keeps the editor usable", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    const { AdminReactionRolesPage } =
      await import("../src/admin/components/admin-reaction-roles-page");
    globalThis.fetch = async () =>
      Response.json({
        roles: [{ id: "300", name: "DayZ" }],
        textChannels: [],
        categories: [],
        voiceChannels: [],
        forumChannels: [],
      });
    const published = { ...panel, messageId: "500", publishedOptions: panel.options };
    assert.equal(
      isPublishedReactionRoleOption(published, { ...panel.options[0], emoji: "" }),
      false,
    );
    await render(
      <AdminReactionRolesPage
        selectedGuildId="100"
        selectedWorkspaceId="workspace-1"
        initialData={{ panel: published }}
      />,
    );
    await click("Add role choice");
    const trigger = container.querySelector<HTMLButtonElement>("#reaction-role-1");
    assert.ok(trigger);
    await act(async () =>
      trigger.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    const role = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent === "@DayZ",
    );
    assert.ok(role);
    await act(async () =>
      role.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    assert.equal(container.querySelectorAll("fieldset").length, 2);
    assert.equal(container.querySelector<HTMLButtonElement>("#reaction-role-1")?.disabled, false);
    await click("Save draft");
    assert.match(
      container.querySelector('[role="alert"]')?.textContent ?? "",
      /emoji|string|character/i,
    );
    await click("Remove choice 2");
    assert.equal(container.querySelectorAll("fieldset").length, 1);
  });
});
