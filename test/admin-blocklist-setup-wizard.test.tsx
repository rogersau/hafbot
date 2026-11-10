/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderToString } from "react-dom/server";

import { BlocklistSetupWizard } from "../src/admin/components/blocklist-setup-wizard";

function renderWizard(currentEmojis: string[]) {
  return renderToString(
    <BlocklistSetupWizard
      currentEmojis={currentEmojis}
      resources={null}
      channelMode="include"
      channelIds={[]}
      notificationChannelId=""
      onSubmit={() => true}
      onChannelModeChange={() => undefined}
      onChannelIdsChange={() => undefined}
      onNotificationChannelChange={() => undefined}
      onFinish={() => undefined}
    />,
  );
}

test("BlocklistSetupWizard requires a blocked emoji before continuing", () => {
  const html = renderWizard([]);

  assert.match(html, /Blocklist setup wizard/);
  assert.match(html, /Block at least one emoji to continue\./);
  assert.equal(findButton(html, "Continue").disabled, true);
});

test("BlocklistSetupWizard presents the Blocklist batch emoji picker", () => {
  const html = renderWizard([]);

  assert.match(html, /Choose emojis/);
});

test("BlocklistSetupWizard enables its simple flow after an emoji is blocked", () => {
  const html = renderWizard(["🔥"]);

  assert.match(html, /1 emoji is blocked\./);
  assert.doesNotMatch(html, /Block at least one emoji to continue\./);
  assert.equal(findButton(html, "Continue").disabled, false);
});

function findButton(html: string, label: string): HTMLButtonElement {
  const document = new JSDOM(html).window.document;
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  assert.ok(button, `Expected ${label} button`);
  return button;
}
