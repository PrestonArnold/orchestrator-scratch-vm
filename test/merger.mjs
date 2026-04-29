/**
 * test/merger.mjs
 *
 * Tests ProjectMerger — 3-way merge over CanonicalProjects.
 *
 * Cases covered:
 *   1.  Identical branches → clean merge, no conflicts
 *   2.  Only ours changed a field → change applied
 *   3.  Only theirs changed a field → change applied
 *   4.  Both changed same field to same value → applied once, no conflict
 *   5.  Both changed same field to different values → CONFLICT, base kept
 *   6.  Ours added a block → block present in result
 *   7.  Theirs added a block → block present in result
 *   8.  Both added different blocks → both present in result
 *   9.  Ours removed a block → block absent in result
 *  10.  Both removed same block → block absent in result
 *  11.  Ours changed input, theirs changed different input → both applied
 *  12.  Both changed same input to different values → CONFLICT
 *  13.  Ours changed opcode, theirs unchanged → applied
 *  14.  Both changed opcode differently → CONFLICT
 *  15.  Ours rewired connection, theirs unchanged → applied
 *  16.  Both rewired same connection differently → CONFLICT
 *  17.  Ours added target, theirs unchanged → target present
 *  18.  Ours removed target, theirs unchanged → target absent
 *  19.  Structure change: block moved (parent) on one side → applied
 *  20.  Both moved same block to different parents → CONFLICT
 *  21.  Non-conflicting block changes on same target merge cleanly
 */

import { ProjectMerger } from "../dist/index.js";

const merger = new ProjectMerger();
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

function assertClean(result, message) {
  assert(result.clean, `${message} — clean`);
  assert(result.conflicts.length === 0, `${message} — no conflicts`);
}

function assertConflict(result, blockId, aspect, key, message) {
  const c = result.conflicts.find(
    (c) => c.blockId === blockId && c.aspect === aspect && c.key === key,
  );
  assert(!result.clean, `${message} — not clean`);
  assert(c !== undefined, `${message} — conflict recorded (${aspect}.${key} on ${blockId})`);
}

// ─── Factories ────────────────────────────────────────────────────────────────

function makeBlock(overrides = {}) {
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

function makeTarget(id, blocks = {}, overrides = {}) {
  return {
    stableId: id,
    isStage: false,
    name: "Sprite1",
    variables: {},
    lists: {},
    broadcasts: {},
    blocks,
    comments: {},
    currentCostume: 0,
    costumes: [],
    sounds: [],
    volume: 100,
    layerOrder: 1,
    visible: true,
    x: 0,
    y: 0,
    size: 100,
    direction: 90,
    draggable: false,
    rotationStyle: "all around",
    ...overrides,
  };
}

function makeProject(targets) {
  return {
    targets,
    monitors: [],
    extensions: [],
    meta: { semver: "3.0.0" },
  };
}

// Convenience: single-target projects keyed by "sprite"
function singleTarget(blocks, targetOverrides = {}) {
  return makeProject([makeTarget("sprite", blocks, targetOverrides)]);
}

function getTarget(result) {
  return result.project.targets.find((t) => t.stableId === "sprite");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log("\n── Test 1: identical branches → clean merge");
{
  const blocks = { aaa: makeBlock() };
  const base   = singleTarget(blocks);
  const result = merger.merge(base, base, base);
  assertClean(result, "identical");
  assert(result.project.targets.length === 1, "one target");
  assert(getTarget(result).blocks.aaa !== undefined, "block present");
}

console.log("\n── Test 2: only ours changed a field");
{
  const base   = singleTarget({ aaa: makeBlock({ fields: { DIRECTION: ["90", null] } }) });
  const ours   = singleTarget({ aaa: makeBlock({ fields: { DIRECTION: ["180", null] } }) });
  const theirs = structuredClone(base);

  const result = merger.merge(base, ours, theirs);
  assertClean(result, "one-sided field change");
  assert(getTarget(result).blocks.aaa.fields.DIRECTION[0] === "180", "ours field applied");
}

console.log("\n── Test 3: only theirs changed a field");
{
  const base   = singleTarget({ aaa: makeBlock({ fields: { DIRECTION: ["90", null] } }) });
  const theirs = singleTarget({ aaa: makeBlock({ fields: { DIRECTION: ["45", null] } }) });
  const ours   = structuredClone(base);

  const result = merger.merge(base, ours, theirs);
  assertClean(result, "one-sided field change (theirs)");
  assert(getTarget(result).blocks.aaa.fields.DIRECTION[0] === "45", "theirs field applied");
}

console.log("\n── Test 4: both changed same field to same value → no conflict");
{
  const base   = singleTarget({ aaa: makeBlock({ inputs: { STEPS: [1, [4, "10"]] } }) });
  const ours   = singleTarget({ aaa: makeBlock({ inputs: { STEPS: [1, [4, "20"]] } }) });
  const theirs = singleTarget({ aaa: makeBlock({ inputs: { STEPS: [1, [4, "20"]] } }) });

  const result = merger.merge(base, ours, theirs);
  assertClean(result, "same change both sides");
  assert(
    JSON.stringify(getTarget(result).blocks.aaa.inputs.STEPS[1]) === JSON.stringify([4, "20"]),
    "merged value is 20",
  );
}

console.log("\n── Test 5: both changed same field to different values → CONFLICT");
{
  const base   = singleTarget({ aaa: makeBlock({ inputs: { STEPS: [1, [4, "10"]] } }) });
  const ours   = singleTarget({ aaa: makeBlock({ inputs: { STEPS: [1, [4, "20"]] } }) });
  const theirs = singleTarget({ aaa: makeBlock({ inputs: { STEPS: [1, [4, "30"]] } }) });

  const result = merger.merge(base, ours, theirs);
  assertConflict(result, "aaa", "input", "STEPS", "divergent input change");
  // Base value preserved on conflict
  assert(
    JSON.stringify(getTarget(result).blocks.aaa.inputs.STEPS[1]) === JSON.stringify([4, "10"]),
    "base value kept on conflict",
  );
}

console.log("\n── Test 6: ours added a block");
{
  const base   = singleTarget({ aaa: makeBlock() });
  const ours   = singleTarget({ aaa: makeBlock(), bbb: makeBlock({ opcode: "motion_turnright" }) });
  const theirs = structuredClone(base);

  const result = merger.merge(base, ours, theirs);
  assertClean(result, "ours added block");
  assert(getTarget(result).blocks.bbb !== undefined, "added block present");
  assert(getTarget(result).blocks.bbb.opcode === "motion_turnright", "added block has correct opcode");
}

console.log("\n── Test 7: theirs added a block");
{
  const base   = singleTarget({ aaa: makeBlock() });
  const theirs = singleTarget({ aaa: makeBlock(), ccc: makeBlock({ opcode: "looks_say" }) });
  const ours   = structuredClone(base);

  const result = merger.merge(base, ours, theirs);
  assertClean(result, "theirs added block");
  assert(getTarget(result).blocks.ccc !== undefined, "theirs block present");
}

console.log("\n── Test 8: both added different blocks");
{
  const base   = singleTarget({ aaa: makeBlock() });
  const ours   = singleTarget({ aaa: makeBlock(), bbb: makeBlock({ opcode: "motion_turnright" }) });
  const theirs = singleTarget({ aaa: makeBlock(), ccc: makeBlock({ opcode: "looks_say" }) });

  const result = merger.merge(base, ours, theirs);
  assertClean(result, "both added different blocks");
  assert(getTarget(result).blocks.bbb !== undefined, "ours addition present");
  assert(getTarget(result).blocks.ccc !== undefined, "theirs addition present");
}

console.log("\n── Test 9: ours removed a block");
{
  const base   = singleTarget({ aaa: makeBlock(), bbb: makeBlock() });
  const ours   = singleTarget({ aaa: makeBlock() });
  const theirs = structuredClone(base);

  const result = merger.merge(base, ours, theirs);
  assertClean(result, "ours removed block");
  assert(getTarget(result).blocks.bbb === undefined, "removed block gone");
  assert(getTarget(result).blocks.aaa !== undefined, "other block still there");
}

console.log("\n── Test 10: both removed same block");
{
  const base   = singleTarget({ aaa: makeBlock(), bbb: makeBlock() });
  const ours   = singleTarget({ aaa: makeBlock() });
  const theirs = singleTarget({ aaa: makeBlock() });

  const result = merger.merge(base, ours, theirs);
  assertClean(result, "both removed same block");
  assert(getTarget(result).blocks.bbb === undefined, "removed block gone");
}

console.log("\n── Test 11: ours changed input A, theirs changed input B → both applied");
{
  const base = singleTarget({
    aaa: makeBlock({ inputs: { STEPS: [1, [4, "10"]], TIMES: [1, [6, "3"]] } }),
  });
  const ours = singleTarget({
    aaa: makeBlock({ inputs: { STEPS: [1, [4, "20"]], TIMES: [1, [6, "3"]] } }),
  });
  const theirs = singleTarget({
    aaa: makeBlock({ inputs: { STEPS: [1, [4, "10"]], TIMES: [1, [6, "5"]] } }),
  });

  const result = merger.merge(base, ours, theirs);
  assertClean(result, "non-overlapping inputs merge");
  const b = getTarget(result).blocks.aaa;
  assert(JSON.stringify(b.inputs.STEPS[1])  === JSON.stringify([4, "20"]), "STEPS updated to 20");
  assert(JSON.stringify(b.inputs.TIMES[1]) === JSON.stringify([6, "5"]),  "TIMES updated to 5");
}

console.log("\n── Test 12: both changed same input differently → CONFLICT");
{
  const base   = singleTarget({ aaa: makeBlock({ inputs: { STEPS: [1, [4, "10"]] } }) });
  const ours   = singleTarget({ aaa: makeBlock({ inputs: { STEPS: [1, [4, "20"]] } }) });
  const theirs = singleTarget({ aaa: makeBlock({ inputs: { STEPS: [1, [4, "99"]] } }) });

  const result = merger.merge(base, ours, theirs);
  assertConflict(result, "aaa", "input", "STEPS", "divergent input");
}

console.log("\n── Test 13: ours changed opcode, theirs unchanged → applied");
{
  const base   = singleTarget({ aaa: makeBlock({ opcode: "motion_movesteps" }) });
  const ours   = singleTarget({ aaa: makeBlock({ opcode: "motion_turnright" }) });
  const theirs = structuredClone(base);

  const result = merger.merge(base, ours, theirs);
  assertClean(result, "one-sided opcode change");
  assert(getTarget(result).blocks.aaa.opcode === "motion_turnright", "opcode applied");
}

console.log("\n── Test 14: both changed opcode differently → CONFLICT");
{
  const base   = singleTarget({ aaa: makeBlock({ opcode: "motion_movesteps" }) });
  const ours   = singleTarget({ aaa: makeBlock({ opcode: "motion_turnright" }) });
  const theirs = singleTarget({ aaa: makeBlock({ opcode: "motion_turnleft" }) });

  const result = merger.merge(base, ours, theirs);
  assertConflict(result, "aaa", "opcode", "opcode", "divergent opcode");
  assert(getTarget(result).blocks.aaa.opcode === "motion_movesteps", "base opcode kept");
}

console.log("\n── Test 15: ours rewired connection, theirs unchanged → applied");
{
  const base   = singleTarget({ aaa: makeBlock({ inputs: { CONDITION: [2, "bbb"] } }) });
  const ours   = singleTarget({ aaa: makeBlock({ inputs: { CONDITION: [2, "ccc"] } }) });
  const theirs = structuredClone(base);

  const result = merger.merge(base, ours, theirs);
  assertClean(result, "one-sided connection rewire");
  assert(getTarget(result).blocks.aaa.inputs.CONDITION[1] === "ccc", "connection rewired");
}

console.log("\n── Test 16: both rewired same connection differently → CONFLICT");
{
  const base   = singleTarget({ aaa: makeBlock({ inputs: { CONDITION: [2, "bbb"] } }) });
  const ours   = singleTarget({ aaa: makeBlock({ inputs: { CONDITION: [2, "ccc"] } }) });
  const theirs = singleTarget({ aaa: makeBlock({ inputs: { CONDITION: [2, "ddd"] } }) });

  const result = merger.merge(base, ours, theirs);
  assertConflict(result, "aaa", "input", "CONDITION", "divergent rewire");
}

console.log("\n── Test 17: ours added a target, theirs unchanged");
{
  const base   = makeProject([makeTarget("stage", {}, { isStage: true, name: "Stage" })]);
  const ours   = makeProject([
    makeTarget("stage", {}, { isStage: true, name: "Stage" }),
    makeTarget("cat", { aaa: makeBlock() }),
  ]);
  const theirs = structuredClone(base);

  const result = merger.merge(base, ours, theirs);
  assertClean(result, "ours added target");
  assert(result.project.targets.some((t) => t.stableId === "cat"), "new target present");
}

console.log("\n── Test 18: ours removed a target, theirs unchanged");
{
  const base   = makeProject([
    makeTarget("stage", {}, { isStage: true, name: "Stage" }),
    makeTarget("cat", { aaa: makeBlock() }),
  ]);
  const ours   = makeProject([makeTarget("stage", {}, { isStage: true, name: "Stage" })]);
  const theirs = structuredClone(base);

  const result = merger.merge(base, ours, theirs);
  assertClean(result, "ours removed target");
  assert(!result.project.targets.some((t) => t.stableId === "cat"), "removed target gone");
}

console.log("\n── Test 19: structure change — block moved on one side");
{
  const base   = singleTarget({ aaa: makeBlock({ parent: "xxx", topLevel: false }) });
  const ours   = singleTarget({ aaa: makeBlock({ parent: "yyy", topLevel: false }) });
  const theirs = structuredClone(base);

  const result = merger.merge(base, ours, theirs);
  assertClean(result, "one-sided parent move");
  assert(getTarget(result).blocks.aaa.parent === "yyy", "parent updated");
}

console.log("\n── Test 20: both moved same block to different parents → CONFLICT");
{
  const base   = singleTarget({ aaa: makeBlock({ parent: "xxx", topLevel: false }) });
  const ours   = singleTarget({ aaa: makeBlock({ parent: "yyy", topLevel: false }) });
  const theirs = singleTarget({ aaa: makeBlock({ parent: "zzz", topLevel: false }) });

  const result = merger.merge(base, ours, theirs);
  assertConflict(result, "aaa", "structure", "parent", "divergent parent move");
}

console.log("\n── Test 21: non-conflicting changes across two blocks on same target");
{
  const base = singleTarget({
    aaa: makeBlock({ inputs: { STEPS: [1, [4, "10"]] } }),
    bbb: makeBlock({ opcode: "looks_say" }),
  });
  const ours = singleTarget({
    aaa: makeBlock({ inputs: { STEPS: [1, [4, "50"]] } }),  // changed STEPS
    bbb: makeBlock({ opcode: "looks_say" }),
  });
  const theirs = singleTarget({
    aaa: makeBlock({ inputs: { STEPS: [1, [4, "10"]] } }),
    bbb: makeBlock({ opcode: "looks_sayforsecs" }),          // changed opcode
  });

  const result = merger.merge(base, ours, theirs);
  assertClean(result, "non-overlapping changes on same target");
  const t = getTarget(result);
  assert(JSON.stringify(t.blocks.aaa.inputs.STEPS[1]) === JSON.stringify([4, "50"]), "STEPS=50 from ours");
  assert(t.blocks.bbb.opcode === "looks_sayforsecs", "opcode from theirs");
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
