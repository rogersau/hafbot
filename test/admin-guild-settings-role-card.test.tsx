/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { renderToString } from "react-dom/server";

import { AdminGuildSettingsPage } from "../src/admin/components/admin-guild-settings-page";

test("Guild Settings disables Save until a saved role has a valid changed selection", () => {
  const html = renderToString(
    <AdminGuildSettingsPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{ adminRoleId: "123456789012345678" }}
    />,
  );

  assert.match(html, /The selected role no longer exists in Discord/);
  assert.match(html, /<button[^>]*disabled[^>]*>[\s\S]*?Save/);
  assert.match(html, /Unavailable role · 123456789012345678/);
});

test("Guild Settings keeps the access distinction and exposes discard affordance", () => {
  const html = renderToString(
    <AdminGuildSettingsPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{ adminRoleId: null }}
    />,
  );

  assert.match(html, /This does not grant additional Discord permissions\./);
  assert.match(html, /Discard changes/);
  assert.match(html, /<button[^>]*disabled[^>]*>[\s\S]*?Save/);
});
