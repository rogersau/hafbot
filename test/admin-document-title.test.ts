/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import test from "node:test";

import { buildAdminDocumentTitle } from "../src/admin/lib/admin-document-title";

const guildDirectory = [
  {
    guildId: "guild-1",
    name: "My Server",
    label: "My Server",
    icon: null,
  },
];

test("buildAdminDocumentTitle uses stable unauthenticated and global titles", () => {
  assert.equal(
    buildAdminDocumentTitle({
      authenticated: false,
      currentPath: "/admin/lfg",
      selectedGuildId: "guild-1",
      guildDirectory,
    }),
    "Sign in | HAF Bot",
  );
  assert.equal(
    buildAdminDocumentTitle({
      authenticated: true,
      currentPath: "/admin",
      selectedGuildId: "guild-1",
      guildDirectory,
    }),
    "Overview | HAF Bot",
  );
  assert.equal(
    buildAdminDocumentTitle({
      authenticated: true,
      currentPath: "/admin/billing",
      selectedGuildId: "guild-1",
      guildDirectory,
    }),
    "Billing | HAF Bot",
  );
});

test("buildAdminDocumentTitle includes a resolved Guild name on flat and Guild-scoped routes", () => {
  for (const currentPath of ["/admin/lfg", "/admin/guild-1/lfg"]) {
    assert.equal(
      buildAdminDocumentTitle({
        authenticated: true,
        currentPath,
        selectedGuildId: "guild-1",
        guildDirectory,
      }),
      "LFG · My Server | HAF Bot",
    );
  }
});

test("buildAdminDocumentTitle never exposes an unresolved raw Guild ID", () => {
  const title = buildAdminDocumentTitle({
    authenticated: true,
    currentPath: "/admin/123456789012345678/lfg",
    selectedGuildId: "123456789012345678",
    guildDirectory,
  });

  assert.equal(title, "LFG | HAF Bot");
  assert.doesNotMatch(title, /123456789012345678/);
});
