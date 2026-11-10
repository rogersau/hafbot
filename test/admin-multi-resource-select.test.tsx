/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";
import { renderToString } from "react-dom/server";
import { act, useState } from "react";
import { withAdminDom } from "./support/admin-dom";

import {
  ChannelSelect,
  MultiChannelSelect,
  MultiResourceActions,
  MultiRoleSelect,
  RoleSelect,
} from "../src/admin/components/guild-resource-select";

const channels = [
  { id: "ch-1", name: "general" },
  { id: "ch-2", name: "support" },
  { id: "ch-3", name: "transcripts" },
];

const roles = [
  { id: "role-1", name: "Admin" },
  { id: "role-2", name: "Mod" },
];

for (const kind of ["channels", "roles"] as const) {
  test(`deferred ${kind} options preserve individual selection, select all, and clear all`, async () => {
    await withAdminDom(async ({ container, render, click }) => {
      function Harness() {
        const [value, onChange] = useState<string[]>([]);
        return kind === "channels" ? (
          <MultiChannelSelect value={value} onChange={onChange} channels={channels} />
        ) : (
          <MultiRoleSelect value={value} onChange={onChange} roles={roles} />
        );
      }
      await render(<Harness />);
      const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]');
      assert.ok(trigger);
      assert.equal(document.querySelector('[cmdk-root=""]'), null);
      await act(async () => trigger.click());
      const option = document.querySelector<HTMLElement>('[role="option"]');
      assert.ok(option, "the dynamically loaded options are usable");
      await act(async () => option.click());
      assert.match(trigger.textContent ?? "", kind === "channels" ? /#general/ : /@Admin/);
      await click("Select all");
      assert.match(trigger.textContent ?? "", kind === "channels" ? /3 selected/ : /@Admin, @Mod/);
      await click("Clear all");
      assert.match(
        trigger.textContent ?? "",
        kind === "channels" ? /Select channels/ : /Select roles/,
      );
      const close = document.querySelector<HTMLButtonElement>('[aria-label="Close options"]');
      assert.ok(close);
      await act(async () => close.click());
      assert.equal(document.querySelector('[cmdk-root=""]'), null);
      await act(async () => trigger.click());
      assert.ok(document.querySelector('[role="option"]'), "options remain usable after reopening");
    });
  });
}

test("single resource selectors use Discord-style channel and role labels", () => {
  const channelHtml = renderToString(
    <ChannelSelect value="ch-1" onChange={() => undefined} channels={channels} />,
  );
  const roleHtml = renderToString(
    <RoleSelect value="role-1" onChange={() => undefined} roles={roles} />,
  );

  assert.match(channelHtml, /#general/);
  assert.match(roleHtml, /@Admin/);
});

test("single resource selectors preserve and clearly label unavailable values", () => {
  const channelHtml = renderToString(
    <ChannelSelect
      value="123456789012345678"
      onChange={() => undefined}
      channels={channels}
      aria-describedby="existing-help"
    />,
  );
  const roleHtml = renderToString(
    <RoleSelect value="234567890123456789" onChange={() => undefined} roles={roles} />,
  );

  assert.match(channelHtml, /Unavailable channel · 123456789012345678/);
  assert.match(
    channelHtml,
    /The selected channel no longer exists in Discord\. Choose another channel and save your changes\./,
  );
  assert.match(channelHtml, /aria-describedby="existing-help [^"]+"/);
  assert.match(roleHtml, /Unavailable role · 234567890123456789/);
  assert.match(
    roleHtml,
    /The selected role no longer exists in Discord\. Choose another role and save your changes\./,
  );
});

test("MultiChannelSelect renders a combobox trigger with a placeholder when nothing is selected", () => {
  const html = renderToString(
    <MultiChannelSelect value={[]} onChange={() => undefined} channels={channels} />,
  );

  assert.match(html, /role="combobox"/);
  assert.match(html, /Select channels/);
});

test("resource comboboxes preserve their visible accessible names", () => {
  const channelHtml = renderToString(
    <MultiChannelSelect
      id="forum-channel"
      aria-label="Forum Channel"
      value={[]}
      onChange={() => undefined}
      channels={channels}
    />,
  );
  const roleHtml = renderToString(
    <MultiRoleSelect
      id="mod-roles"
      aria-label="Mod Roles"
      value={[]}
      onChange={() => undefined}
      roles={roles}
    />,
  );

  assert.match(channelHtml, /role="combobox"[^>]*aria-label="Forum Channel"/);
  assert.match(roleHtml, /role="combobox"[^>]*aria-label="Mod Roles"/);
});

test("multi selectors summarise available resources with Discord-style labels", () => {
  const channelHtml = renderToString(
    <MultiChannelSelect value={["ch-1", "ch-2"]} onChange={() => undefined} channels={channels} />,
  );
  const roleHtml = renderToString(
    <MultiRoleSelect value={["role-1", "role-2"]} onChange={() => undefined} roles={roles} />,
  );

  assert.match(channelHtml, /#general/);
  assert.match(channelHtml, /#support/);
  assert.match(roleHtml, /@Admin/);
  assert.match(roleHtml, /@Mod/);
});

test("MultiChannelSelect collapses long selections to a count summary", () => {
  const html = renderToString(
    <MultiChannelSelect
      value={["ch-1", "ch-2", "ch-3"]}
      onChange={() => undefined}
      channels={channels}
    />,
  );

  assert.match(html, /3 selected/);
});

test("multi selectors label unavailable values and show pluralised warnings", () => {
  const channelHtml = renderToString(
    <MultiChannelSelect
      value={["deleted-channel-1", "deleted-channel-2"]}
      onChange={() => undefined}
      channels={channels}
    />,
  );
  const roleHtml = renderToString(
    <MultiRoleSelect
      value={["deleted-role-1", "deleted-role-2"]}
      onChange={() => undefined}
      roles={roles}
    />,
  );

  assert.match(channelHtml, /Unavailable channel · deleted-channel-1/);
  assert.match(
    channelHtml,
    /2 selected channels no longer exist in Discord\. Remove or replace them before saving\./,
  );
  assert.match(roleHtml, /Unavailable role · deleted-role-1/);
  assert.match(
    roleHtml,
    /2 selected roles no longer exist in Discord\. Remove or replace them before saving\./,
  );
});

test("removing an unavailable value clears its warning", () => {
  const withMissing = renderToString(
    <MultiRoleSelect value={["deleted-role"]} onChange={() => undefined} roles={roles} />,
  );
  const afterRemoval = renderToString(
    <MultiRoleSelect value={["role-1"]} onChange={() => undefined} roles={roles} />,
  );

  assert.match(withMissing, /Unavailable role · deleted-role/);
  assert.match(withMissing, /1 selected role no longer exists/);
  assert.doesNotMatch(afterRemoval, /no longer exists/);
  assert.match(afterRemoval, /@Admin/);
});

test("MultiResourceActions surfaces the selection count and clear/select-all affordances", () => {
  const html = renderToString(
    <MultiResourceActions
      optionsCount={3}
      selectedCount={2}
      onSelectAll={() => undefined}
      onClearAll={() => undefined}
    />,
  );

  assert.match(html, /2.{0,20}\/.{0,20}3.{0,20} selected/);
  assert.match(html, /Select all/);
  assert.match(html, /Clear all/);
  assert.match(html, /data-multi-resource-actions="true"/);
});

test("MultiResourceActions disables Clear all when nothing is selected", () => {
  const html = renderToString(
    <MultiResourceActions
      optionsCount={3}
      selectedCount={0}
      onSelectAll={() => undefined}
      onClearAll={() => undefined}
    />,
  );

  const selectAllButtonStart = html.indexOf("Select all");
  const clearAllButtonStart = html.indexOf("Clear all");
  assert.ok(selectAllButtonStart > 0 && clearAllButtonStart > 0);
  const selectAllButtonTag = html.slice(
    html.lastIndexOf("<button", selectAllButtonStart),
    selectAllButtonStart,
  );
  const clearAllButtonTag = html.slice(
    html.lastIndexOf("<button", clearAllButtonStart),
    clearAllButtonStart,
  );
  assert.doesNotMatch(selectAllButtonTag, /disabled=""/);
  assert.match(clearAllButtonTag, /disabled=""/);
});

test("MultiResourceActions disables Select all when all options are selected", () => {
  const html = renderToString(
    <MultiResourceActions
      optionsCount={3}
      selectedCount={3}
      onSelectAll={() => undefined}
      onClearAll={() => undefined}
    />,
  );

  const selectAllButtonStart = html.indexOf("Select all");
  const clearAllButtonStart = html.indexOf("Clear all");
  assert.ok(selectAllButtonStart > 0 && clearAllButtonStart > 0);
  const selectAllButtonTag = html.slice(
    html.lastIndexOf("<button", selectAllButtonStart),
    selectAllButtonStart,
  );
  const clearAllButtonTag = html.slice(
    html.lastIndexOf("<button", clearAllButtonStart),
    clearAllButtonStart,
  );
  assert.match(selectAllButtonTag, /disabled=""/);
  assert.doesNotMatch(clearAllButtonTag, /disabled=""/);
});

test("MultiResourceActions can hide Select all while retaining Clear all", () => {
  const html = renderToString(
    <MultiResourceActions
      optionsCount={3}
      selectedCount={2}
      onSelectAll={() => undefined}
      onClearAll={() => undefined}
      allowSelectAll={false}
    />,
  );

  assert.doesNotMatch(html, /Select all/);
  assert.match(html, /Clear all/);
  assert.match(html, /2.{0,20}\/.{0,20}3.{0,20} selected/);
});

test("MultiResourceActions renders nothing when there are no options", () => {
  const html = renderToString(
    <MultiResourceActions
      optionsCount={0}
      selectedCount={0}
      onSelectAll={() => undefined}
      onClearAll={() => undefined}
    />,
  );

  assert.equal(html, "");
});
