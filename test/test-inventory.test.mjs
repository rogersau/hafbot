import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertTestInventory,
  getTestInventory,
  listNodeTestPaths,
} from "../scripts/test-inventory.mjs";

const BROWSER_TEST = join("test", "admin-emoji-picker-browser.test.mjs");

test("PostgreSQL contracts build generated landing source before compiling tests", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));

  assert.match(
    manifest.scripts["test:postgres"],
    /^pnpm run build:landing && pnpm run build:test:types && /,
  );
});

test("repeated tests build generated landing source before compiling tests", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));

  assert.match(manifest.scripts["test:repeat"], /^pnpm run build:landing && /);
});

test("every tracked test belongs to exactly one executable suite", () => {
  const inventory = assertTestInventory();

  assert.ok(inventory.node.length > 0, "expected Node tests in the inventory");
  assert.deepEqual(inventory.browser, [BROWSER_TEST]);
  assert.ok(inventory.unit.length > 0, "expected unit tests in the inventory");
  assert.ok(inventory.integration.length > 0, "expected integration tests in the inventory");
  assert.ok(inventory.build.length > 0, "expected build tests in the inventory");
  assert.ok(inventory.architecture.length > 0, "expected architecture tests in the inventory");
  assert.deepEqual(inventory.unassigned, []);
  assert.deepEqual(inventory.duplicateAssignments, []);
});

test("browser tests are discovered from Playwright imports rather than filenames", () => {
  const directory = mkdtempSync(join(tmpdir(), "haf-test-inventory-"));
  try {
    mkdirSync(join(directory, "test"));
    writeFileSync(
      join(directory, "test", "interaction.test.mjs"),
      'import { chromium } from "@playwright/test";\nvoid chromium;\n',
    );
    writeFileSync(join(directory, "test", "ordinary.test.mjs"), 'import test from "node:test";\n');

    assert.deepEqual(getTestInventory(directory).browser, [join("test", "interaction.test.mjs")]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("browser checks can be omitted from the executable Node test list", () => {
  const previous = process.env.TEST_SKIP_BROWSER_CHECKS;
  try {
    delete process.env.TEST_SKIP_BROWSER_CHECKS;
    assert.ok(listNodeTestPaths({ compiled: false }).includes(BROWSER_TEST));

    process.env.TEST_SKIP_BROWSER_CHECKS = "true";
    assert.equal(listNodeTestPaths({ compiled: false }).includes(BROWSER_TEST), false);
  } finally {
    if (previous === undefined) delete process.env.TEST_SKIP_BROWSER_CHECKS;
    else process.env.TEST_SKIP_BROWSER_CHECKS = previous;
  }
});
