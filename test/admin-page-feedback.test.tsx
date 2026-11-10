/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";
import { renderToString } from "react-dom/server";

import { PageFeedback } from "../src/admin/components/page-feedback";

test("PageFeedback renders successful action messages in a polite status region", () => {
  const html = renderToString(<PageFeedback error={null} message="Mention Protection saved." />);

  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Mention Protection saved\./);
});

test("PageFeedback keeps errors distinct and suppresses stale success messages", () => {
  const html = renderToString(
    <PageFeedback error="Saving failed." message="Previous save succeeded." />,
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Saving failed\./);
  assert.doesNotMatch(html, /Previous save succeeded\./);
});
