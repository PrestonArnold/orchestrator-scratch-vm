/**
 * test/block-diff.mjs
 *
 * Tests the BlockDiffer in isolation against known block graph scenarios.
 * These are the four cases that must be correct before merge is built:
 *
 *   1. block added
 *   2. field value changed
 *   3. block moved (parent/next changed)
 *   4. identical graphs → no diff
 */

import { BlockDiffer } from "../dist/index.js";

const differ = new BlockDiffer();
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

function assertNull(val, message) {
  assert(val === null, message);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function block(id, overrides = {}) {
  return {
    opcode: "motion_movesteps",
    next: null,
    parent: null,
    inputs: { STEPS: [1, [4, "10"]] },
    fields: {},
    shadow: false,
    topLevel: true,
    ...overrides,
  };
}

// ─── Test 1: no changes → null ────────────────────────────────────────────────

console.log("\n── Test 1: identical graphs → no diff");
{
  const base = { "aaa": block("aaa"), "bbb": block("bbb") };
  const head = { "aaa": block("aaa"), "bbb": block("bbb") };
  const result = differ.diff(base, head);
  assertNull(result, "diff of identical graphs is null");
}

// ─── Test 2: block added ──────────────────────────────────────────────────────

console.log("\n── Test 2: block added");
{
  const base = { "aaa": block("aaa") };
  const head = { "aaa": block("aaa"), "bbb": block("bbb") };
  const result = differ.diff(base, head);
  assert(result !== null, "diff is non-null");
  assert(result.added.includes("bbb"), "added contains new block ID");
  assert(result.removed.length === 0, "nothing removed");
  assert(result.modified.length === 0, "nothing modified");
}

// ─── Test 3: block removed ────────────────────────────────────────────────────

console.log("\n── Test 3: block removed");
{
  const base = { "aaa": block("aaa"), "bbb": block("bbb") };
  const head = { "aaa": block("aaa") };
  const result = differ.diff(base, head);
  assert(result !== null, "diff is non-null");
  assert(result.removed.includes("bbb"), "removed contains deleted block ID");
  assert(result.added.length === 0, "nothing added");
  assert(result.modified.length === 0, "nothing modified");
}

// ─── Test 4: field value changed ─────────────────────────────────────────────

console.log("\n── Test 4: field value changed");
{
  const base = {
    "aaa": block("aaa", { fields: { VARIABLE: ["score", "var_1"] } }),
  };
  const head = {
    "aaa": block("aaa", { fields: { VARIABLE: ["highscore", "var_1"] } }),
  };
  const result = differ.diff(base, head);
  assert(result !== null, "diff is non-null");
  assert(result.modified.length === 1, "one block modified");
  const change = result.modified[0];
  assert(change.id === "aaa", "correct block ID");
  assert(change.fields?.VARIABLE !== undefined, "VARIABLE field change detected");
  assert(change.fields.VARIABLE.from[0] === "score", "from value is 'score'");
  assert(change.fields.VARIABLE.to[0] === "highscore", "to value is 'highscore'");
}

// ─── Test 5: inline input value changed ──────────────────────────────────────

console.log("\n── Test 5: inline input value changed (10 → 20)");
{
  const base = { "aaa": block("aaa", { inputs: { STEPS: [1, [4, "10"]] } }) };
  const head = { "aaa": block("aaa", { inputs: { STEPS: [1, [4, "20"]] } }) };
  const result = differ.diff(base, head);
  assert(result !== null, "diff is non-null");
  assert(result.modified.length === 1, "one block modified");
  const change = result.modified[0];
  assert(change.inputs?.STEPS !== undefined, "STEPS input change detected");
  assert(change.inputs.STEPS.kind === "value_changed", "kind is value_changed");
}

// ─── Test 6: connection rewired ───────────────────────────────────────────────

console.log("\n── Test 6: input connection rewired");
{
  const base = { "aaa": block("aaa", { inputs: { CONDITION: [2, "bbb"] } }) };
  const head = { "aaa": block("aaa", { inputs: { CONDITION: [2, "ccc"] } }) };
  const result = differ.diff(base, head);
  assert(result !== null, "diff is non-null");
  const change = result.modified[0];
  assert(change.inputs?.CONDITION.kind === "connection_changed", "kind is connection_changed");
  assert(change.inputs.CONDITION.from === "bbb", "from is old block ID");
  assert(change.inputs.CONDITION.to === "ccc", "to is new block ID");
}

// ─── Test 7: block moved (parent changed) ────────────────────────────────────

console.log("\n── Test 7: block moved (parent changed)");
{
  const base = { "aaa": block("aaa", { parent: "xxx", topLevel: false }) };
  const head = { "aaa": block("aaa", { parent: "yyy", topLevel: false }) };
  const result = differ.diff(base, head);
  assert(result !== null, "diff is non-null");
  const change = result.modified[0];
  assert(change.structure?.parent !== undefined, "parent change detected");
  assert(change.structure.parent.from === "xxx", "from is old parent");
  assert(change.structure.parent.to === "yyy", "to is new parent");
}

// ─── Test 8: layout-only change (x/y) → no diff ──────────────────────────────

console.log("\n── Test 8: x/y position change only → no diff");
{
  const base = { "aaa": block("aaa", { x: 100, y: 200 }) };
  const head = { "aaa": block("aaa", { x: 300, y: 400 }) };
  const result = differ.diff(base, head);
  assertNull(result, "layout-only change produces no diff");
}

// ─── Test 9: opcode changed ───────────────────────────────────────────────────

console.log("\n── Test 9: opcode changed");
{
  const base = { "aaa": block("aaa", { opcode: "motion_movesteps" }) };
  const head = { "aaa": block("aaa", { opcode: "motion_turnright" }) };
  const result = differ.diff(base, head);
  assert(result !== null, "diff is non-null");
  const change = result.modified[0];
  assert(change.opcode !== undefined, "opcode change detected");
  assert(change.opcode.from === "motion_movesteps", "from opcode correct");
  assert(change.opcode.to === "motion_turnright", "to opcode correct");
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
