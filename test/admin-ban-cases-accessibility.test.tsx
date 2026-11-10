/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";
import { renderToString } from "react-dom/server";

import { AdminBanCasesPage } from "../src/admin/components/admin-ban-cases-page";

test("Ban Cases names the Platform, Forum Channel, and Mod Roles comboboxes", () => {
  const html = renderToString(
    <AdminBanCasesPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{ guildId: "guild-1", config: null, sources: [] }}
    />,
  );

  assert.match(html, /<label[^>]*for="bc-platform"[^>]*>Platform<\/label>/);
  assert.match(html, /<select[^>]*id="bc-platform"/);
  assert.match(html, /<label[^>]*for="bc-forum-channel"[^>]*>Forum Channel<\/label>/);
  assert.match(html, /<button(?=[^>]*id="bc-forum-channel")(?=[^>]*role="combobox")[^>]*>/);
  assert.match(html, /<label[^>]*for="bc-mod-roles"[^>]*>Mod Roles<\/label>/);
  assert.match(html, /<button(?=[^>]*id="bc-mod-roles")(?=[^>]*role="combobox")[^>]*>/);
  assert.match(html, /Test configuration/);
  assert.match(html, /Sample webhook body/);
});
