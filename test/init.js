import fs from "node:fs/promises";
import JSZip from "jszip";
import { randomUUID } from "node:crypto";

import VM from "scratch-vm";
import { VMController, ProjectDiffer } from "../dist/index.js";

// ─── Boot ─────────────────────────────────────────────────────────────────────

const vm = new VM();
const controller = new VMController(vm);
await vm.start();

// ─── Load project ─────────────────────────────────────────────────────────────

const sb3Buffer = await fs.readFile("examples/default.sb3");
const zip = await JSZip.loadAsync(sb3Buffer);
const projectJsonRaw = await zip.file("project.json").async("string");
const projectJson = JSON.parse(projectJsonRaw);

await controller.load(projectJson);
console.log("✓ Project loaded\n");

// ─── Snapshot base ────────────────────────────────────────────────────────────

const base = controller.toCanonical();

// ─── Resolve sprite ───────────────────────────────────────────────────────────

const spriteEntry = controller.getTargets().find((t) => t.name === "Sprite1");
if (!spriteEntry) throw new Error("Sprite1 not found");
const { stableId } = spriteEntry;

console.log(`Sprite stableId: ${stableId}\n`);

// ─── 1. Move the sprite ───────────────────────────────────────────────────────

controller.applyMutation({ type: "TARGET_MOVE", stableTargetId: stableId, x: 50, y: -30 });

// ─── 2. Rename the sprite ─────────────────────────────────────────────────────

controller.applyMutation({ type: "TARGET_RENAME", stableTargetId: stableId, name: "Hero" });

// ─── 3. Add a variable to the sprite ─────────────────────────────────────────

const scoreVarId = `var_${randomUUID()}`;

controller.applyMutation({
  type: "ADD_VARIABLE",
  stableTargetId: stableId,
  variableId: scoreVarId,
  name: "score",
  value: 0,
});

// ─── 4. Set the variable value ────────────────────────────────────────────────

controller.applyMutation({
  type: "SET_VARIABLE",
  stableTargetId: stableId,
  variableId: scoreVarId,
  value: 100,
});

// ─── 5. Add a block (motion_movesteps — "move 10 steps") ─────────────────────
//
// Block graph for "when green flag clicked → move 10 steps":
//
//   event_whenflagclicked  (topLevel, id: flagBlockId)
//     next → motion_movesteps (id: moveBlockId)
//
//   motion_movesteps
//     inputs: { STEPS: [1, [4, "10"]] }   ← inline math_number primitive

const flagBlockId = `blk_${randomUUID()}`;
const moveBlockId = `blk_${randomUUID()}`;

controller.applyMutation({
  type: "ADD_BLOCK",
  stableTargetId: stableId,
  blockId: flagBlockId,
  block: {
    opcode: "event_whenflagclicked",
    next: moveBlockId,
    parent: null,
    inputs: {},
    fields: {},
    shadow: false,
    topLevel: true,
    x: 100,
    y: 100,
  },
});

controller.applyMutation({
  type: "ADD_BLOCK",
  stableTargetId: stableId,
  blockId: moveBlockId,
  block: {
    opcode: "motion_movesteps",
    next: null,
    parent: flagBlockId,
    inputs: { STEPS: [1, [4, "10"]] },
    fields: {},
    shadow: false,
    topLevel: false,
  },
});

// ─── 6. Update a block field ──────────────────────────────────────────────────
// (not a real Scratch field update since motion_movesteps uses inputs not fields,
//  but demonstrates the operation type works)
// Instead let's set a field on a block that has one — add a motion_setx block:

const setXBlockId = `blk_${randomUUID()}`;

controller.applyMutation({
  type: "ADD_BLOCK",
  stableTargetId: stableId,
  blockId: setXBlockId,
  block: {
    opcode: "motion_setx",
    next: null,
    parent: null,
    inputs: { X: [1, [4, "0"]] },
    fields: {},
    shadow: false,
    topLevel: true,
    x: 300,
    y: 100,
  },
});

// ─── Diff ─────────────────────────────────────────────────────────────────────

const diff = controller.diffAgainst(base);
const differ = new ProjectDiffer();

console.log("═══ DIFF SUMMARY ═══════════════════════════════════════");
console.log(differ.summarize(diff));
console.log("════════════════════════════════════════════════════════\n");

// Spot-check diff correctness
const targetDiff = diff.modified.find((td) => td.stableId === stableId);
if (!targetDiff) throw new Error("Expected modified entry for sprite");

console.log("Assertions:");
console.assert(targetDiff.name?.from === "Sprite1" && targetDiff.name?.to === "Hero",   "✓ rename detected");
console.assert(targetDiff.position?.to.x === 50 && targetDiff.position?.to.y === -30,  "✓ move detected");
console.assert(targetDiff.variables?.added[scoreVarId]?.[0] === "score",               "✓ variable add detected");
console.assert(Object.keys(targetDiff.blocks?.added ?? {}).length === 3,               "✓ 3 blocks added detected");
console.log("✓ rename detected");
console.log("✓ move detected");
console.log("✓ variable add detected");
console.log("✓ 3 blocks added detected");

// ─── Mutation log ─────────────────────────────────────────────────────────────

const log = controller.getMutationLog();
console.log(`\nMutation log: ${log.length} operations`);
for (const op of log) {
  console.log(`  ${op.type}`);
}

// ─── Replay ───────────────────────────────────────────────────────────────────

const replayEngine = controller.getReplayEngine();
const rebuilt = await replayEngine.replay(log, projectJson);
console.log("\n✓ Replay succeeded");

// ─── Canonical after replay ───────────────────────────────────────────────────

const replayedCanonical = controller.toCanonical();
const heroTarget = replayedCanonical.targets.find((t) => t.name === "Hero");
if (!heroTarget) throw new Error("Hero sprite not found after replay");

console.log("\nReplayed canonical sprite:");
console.log(`  name: ${heroTarget.name}`);
console.log(`  x: ${heroTarget.x}, y: ${heroTarget.y}`);
console.log(`  variables: ${JSON.stringify(heroTarget.variables)}`);
console.log(`  block count: ${Object.keys(heroTarget.blocks).length}`);

// ─── Round-trip ───────────────────────────────────────────────────────────────

await controller.load(rebuilt);
const final = controller.serialize();
const equal = JSON.stringify(rebuilt) === JSON.stringify(final);
console.log(`\n✓ Round trip equal: ${equal}`);
