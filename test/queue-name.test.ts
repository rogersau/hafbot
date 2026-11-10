/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { isConfiguredQueue, queueNameForEnvironment } from "../src/runtime/queue-name";

test("queue names resolve to isolated staging resources without weakening production routing", () => {
  assert.equal(
    queueNameForEnvironment("haf-bot-billing-sync", true),
    "haf-bot-staging-billing-sync",
  );
  assert.equal(queueNameForEnvironment("haf-bot-billing-sync", false), "haf-bot-billing-sync");
  assert.equal(
    isConfiguredQueue("haf-bot-staging-billing-sync", "haf-bot-billing-sync", true),
    true,
  );
  assert.equal(
    isConfiguredQueue("haf-bot-staging-billing-sync", "haf-bot-billing-sync", false),
    false,
  );
});
