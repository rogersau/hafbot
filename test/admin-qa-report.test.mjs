import assert from "node:assert/strict";
import test from "node:test";
import { exitCode, selectScenarios, summarize } from "../scripts/admin-qa/report.mjs";

test("Admin QA report distinguishes failure, blocked, and never-run checks", () => {
  const cases = ["pass", "fail", "blocked", "not-run"].map((status) => ({ status }));
  assert.deepEqual(summarize(cases), { pass: 1, fail: 1, blocked: 1, "not-run": 1 });
  assert.equal(exitCode(cases), 1);
  assert.equal(exitCode([{ status: "blocked" }]), 2);
  assert.equal(exitCode([{ status: "not-run" }]), 2);
  assert.equal(exitCode([{ status: "pass" }, { status: "not-run" }]), 0);
  assert.throws(() => summarize([{ status: "skip" }]), /Invalid QA status/);
});

test("Admin QA selection fails closed on a typo", () => {
  const scenarios = [{ id: "first" }, { id: "second" }];
  assert.deepEqual(selectScenarios(scenarios, "second"), [{ id: "second" }]);
  assert.equal(selectScenarios(scenarios), scenarios);
  assert.throws(() => selectScenarios(scenarios, "frst"), /Unknown Admin QA scenario/);
});
