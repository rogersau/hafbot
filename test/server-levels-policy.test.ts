/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  SERVER_LEVEL_XP_UNITS_PER_XP,
  calculateServerLevel,
  calculateServerLevelProgress,
  calculateServerXpUnits,
  resolveOccupancyMultiplier,
} from "../src/server-levels/policy";

test("Server XP uses the specified occupancy boundaries and trusted queue override", () => {
  assert.equal(resolveOccupancyMultiplier({ population: 1, maxSlots: 4, queueSize: 0 }), 4);
  assert.equal(resolveOccupancyMultiplier({ population: 2, maxSlots: 4, queueSize: 0 }), 3);
  assert.equal(resolveOccupancyMultiplier({ population: 3, maxSlots: 4, queueSize: 0 }), 2);
  assert.equal(resolveOccupancyMultiplier({ population: 4, maxSlots: 4, queueSize: 0 }), 1);
  assert.equal(resolveOccupancyMultiplier({ population: 5, maxSlots: 4, queueSize: 0 }), 1);
  assert.equal(resolveOccupancyMultiplier({ population: 1, maxSlots: 100, queueSize: 1 }), 1);
});

test("Server XP keeps one-sixtieth XP precision across short qualifying intervals", () => {
  assert.equal(SERVER_LEVEL_XP_UNITS_PER_XP, 60);
  assert.equal(calculateServerXpUnits(1, 4), 4);
  assert.equal(calculateServerXpUnits(15, 4), 60);
  assert.equal(calculateServerXpUnits(59, 1), 59);
});

test("Server Level 1 starts at zero and the quadratic curve has no practical cap", () => {
  assert.equal(calculateServerLevel(0), 1);
  assert.equal(calculateServerLevel(100 * 60 - 1), 1);
  assert.equal(calculateServerLevel(100 * 60), 2);
  assert.equal(calculateServerLevel(400 * 60), 3);
  assert.equal(calculateServerLevel(99_800_100 * 60), 1_000);

  assert.deepEqual(calculateServerLevelProgress(250 * 60), {
    level: 2,
    totalXpUnits: 15_000,
    currentLevelXpUnits: 6_000,
    nextLevelXpUnits: 24_000,
    progressXpUnits: 9_000,
    requiredXpUnits: 18_000,
  });
});

test("invalid or empty occupancy facts fail closed", () => {
  assert.equal(resolveOccupancyMultiplier({ population: 0, maxSlots: 100, queueSize: 0 }), null);
  assert.equal(resolveOccupancyMultiplier({ population: -1, maxSlots: 100, queueSize: 0 }), null);
  assert.equal(resolveOccupancyMultiplier({ population: 1, maxSlots: 0, queueSize: 0 }), null);
  assert.equal(resolveOccupancyMultiplier({ population: 1, maxSlots: 100, queueSize: -1 }), null);
});
