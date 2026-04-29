import fs from "node:fs/promises";
import JSZip from "jszip";

import VM from "scratch-vm";
import { VMController, ProjectDiffer } from "../dist/index.js";

// ─── Boot VM + Controller ─────────────────────────────────────────────────────

const vm = new VM();
const controller = new VMController(vm);

await vm.start();

// ─── Load SB3 ────────────────────────────────────────────────────────────────

const sb3Buffer = await fs.readFile("examples/default.sb3");
const zip = await JSZip.loadAsync(sb3Buffer);
const projectJsonRaw = await zip.file("project.json").async("string");
const projectJson = JSON.parse(projectJsonRaw);

await controller.load(projectJson);
console.log("Project loaded");

// ─── Snapshot base canonical state ───────────────────────────────────────────

const baseCanonical = controller.toCanonical();

console.log("Base canonical targets:", baseCanonical.targets.map((t) => ({
  stableId: t.stableId,
  name: t.name,
  isStage: t.isStage,
})));

// ─── Resolve sprite ───────────────────────────────────────────────────────────

const targets = controller.getTargets();
const spriteEntry = targets.find((t) => t.name === "Sprite1");

if (!spriteEntry) {
  throw new Error(`Sprite1 not found. Available: ${targets.map((t) => t.name).join(", ")}`);
}

const { stableId } = spriteEntry;
console.log(`\nUsing Sprite1 → stableId: ${stableId}`);

// ─── Apply mutations ──────────────────────────────────────────────────────────

controller.applyMutation({
  type: "TARGET_MOVE",
  stableTargetId: stableId,
  x: 120,
  y: 80,
});

controller.applyMutation({
  type: "TARGET_RENAME",
  stableTargetId: stableId,
  name: "MySprite",
});

// ─── Diff base vs current ─────────────────────────────────────────────────────

const diff = controller.diffAgainst(baseCanonical);
const differ = new ProjectDiffer();
console.log("\nDiff summary:");
console.log(differ.summarize(diff));

// ─── Mutation log ─────────────────────────────────────────────────────────────

const log = controller.getMutationLog();
console.log("\nMutation log:", JSON.stringify(log, null, 2));

// ─── Replay ───────────────────────────────────────────────────────────────────

const replayEngine = controller.getReplayEngine();
const rebuilt = await replayEngine.replay(log, projectJson);

console.log("\nReplay succeeded!");
console.log("Rebuilt targets:", controller.getTargets());

// ─── Round-trip validation ────────────────────────────────────────────────────

await controller.load(rebuilt);
const final = controller.serialize();

console.log(
  "\nRound trip equal:",
  JSON.stringify(rebuilt) === JSON.stringify(final),
);
