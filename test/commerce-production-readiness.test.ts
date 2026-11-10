/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { isCommerceFeatureEnabled } from "../src/commerce/production-readiness";

test("Commerce is enabled only by the explicit Worker flag", () => {
  assert.equal(isCommerceFeatureEnabled({ COMMERCE_ENABLED: "true" }), true);
  assert.equal(isCommerceFeatureEnabled({ COMMERCE_ENABLED: "false" }), false);
  assert.equal(isCommerceFeatureEnabled({}), false);
});
