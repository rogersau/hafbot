/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";
import { renderToString } from "react-dom/server";

import { CommandPalette, type CommandPaletteItem } from "../src/admin/components/command-palette";
import { resolveAdminCommandPaletteHref } from "../src/admin/components/admin-command-palette";

const items: CommandPaletteItem[] = [
  { id: "page:tickets", label: "Tickets", group: "pages", keywords: ["support"] },
  { id: "page:marketplace", label: "Marketplace", group: "pages" },
  { id: "resource:guild:2", label: "Alpha Server", group: "resources", keywords: ["alpha"] },
  { id: "recent:last-ticket", label: "Last closed ticket", group: "recent", hint: "↵" },
];

test("AdminCommandPalette resolves only pages, servers, and supplied recent actions", () => {
  const recentActions = [
    { id: "ticket-42", label: "Last ticket", href: "/admin/tickets?ticket=42" },
  ];

  assert.equal(
    resolveAdminCommandPaletteHref("page:/admin/tickets", "workspace-1", "guild-1"),
    "/admin/guild-1/tickets?workspaceId=workspace-1",
  );
  assert.equal(
    resolveAdminCommandPaletteHref("guild:guild-2", "workspace-1", "guild-1"),
    "/admin/guild-2?workspaceId=workspace-1",
  );
  assert.equal(
    resolveAdminCommandPaletteHref("recent:ticket-42", "workspace-1", "guild-1", recentActions),
    "/admin/tickets?ticket=42",
  );
  assert.equal(resolveAdminCommandPaletteHref("resource:channel:123", "w", "g"), null);
  assert.equal(resolveAdminCommandPaletteHref("resource:role:456", "w", "g"), null);
});

test("CommandPalette renders nothing when closed", () => {
  const html = renderToString(
    <CommandPalette
      open={false}
      items={items}
      onSelect={() => undefined}
      onDismiss={() => undefined}
    />,
  );

  assert.equal(html, "");
});

test("CommandPalette renders a modal dialog with grouped headings when open", () => {
  const html = renderToString(
    <CommandPalette open items={items} onSelect={() => undefined} onDismiss={() => undefined} />,
  );

  assert.match(html, /data-command-palette="true"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /Dashboard pages/);
  assert.match(html, /Servers/);
  assert.match(html, /Recent actions/);
  assert.match(html, /Tickets/);
  assert.match(html, /Marketplace/);
  assert.match(html, /Alpha Server/);
  assert.match(html, /Last closed ticket/);
});

test("CommandPalette shows the search input with placeholder", () => {
  const html = renderToString(
    <CommandPalette
      open
      items={items}
      onSelect={() => undefined}
      onDismiss={() => undefined}
      placeholder="Search anything…"
    />,
  );

  assert.match(html, /placeholder="Search anything…"/);
});

test("CommandPalette uses actionable default search copy", () => {
  const html = renderToString(
    <CommandPalette open items={items} onSelect={() => undefined} onDismiss={() => undefined} />,
  );

  assert.match(html, /placeholder="Search pages, servers, and recent actions…"/);
  assert.doesNotMatch(html, /Search pages, channels, roles/);
});

test("CommandPalette dismiss button is labelled for screen readers", () => {
  const html = renderToString(
    <CommandPalette open items={items} onSelect={() => undefined} onDismiss={() => undefined} />,
  );

  assert.match(html, /aria-label="Close command palette"/);
});

test("CommandPalette renders item hints alongside the label", () => {
  const html = renderToString(
    <CommandPalette open items={items} onSelect={() => undefined} onDismiss={() => undefined} />,
  );

  assert.match(html, /Last closed ticket/);
  assert.match(html, /↵/);
});

test("CommandPalette shows an empty state when no actionable items remain", () => {
  const html = renderToString(
    <CommandPalette
      open
      items={[{ id: "page:locked", label: "Locked page", group: "pages", disabled: true }]}
      onSelect={() => undefined}
      onDismiss={() => undefined}
    />,
  );

  assert.match(html, /No matches found\./);
});

test("CommandPalette hides disabled items", () => {
  const withDisabled: CommandPaletteItem[] = [
    ...items,
    { id: "page:locked", label: "Locked page", group: "pages", disabled: true },
  ];

  const html = renderToString(
    <CommandPalette
      open
      items={withDisabled}
      onSelect={() => undefined}
      onDismiss={() => undefined}
    />,
  );

  assert.doesNotMatch(html, /Locked page/);
});
