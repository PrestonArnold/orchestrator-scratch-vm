import fs from "node:fs/promises";
import JSZip from "jszip";

import VM from "scratch-vm";
import { VMController } from "../dist/index.js";

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

// ─── Inspect targets (via stable IDs) ────────────────────────────────────────

const targets = controller.getTargets();
console.log("Targets (stable view):", targets);

// Registry debug: shows stable ↔ vm mapping
console.log("Registry:", controller.registry.debug());

// ─── Resolve sprite by name ───────────────────────────────────────────────────

const spriteEntry = targets.find((t) => t.name === "Sprite1");

if (!spriteEntry) {
  throw new Error(
    `Sprite1 not found. Available: ${targets.map((t) => t.name).join(", ")}`,
  );
}

const { stableId } = spriteEntry;
console.log(`Using Sprite1 → stableId: ${stableId}`);

// ─── Mutations (using stableTargetId, not VM id) ──────────────────────────────

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

// ─── Mutation log ─────────────────────────────────────────────────────────────

const log = controller.getMutationLog();
console.log("Mutation log:", JSON.stringify(log, null, 2));

// Note: log entries contain stableTargetId — safe to store, send, or serialize.

// ─── Replay engine test ───────────────────────────────────────────────────────
//
// This is the scenario that previously crashed:
//   1. Mutations logged with old VM ids
//   2. VM reloaded → new VM ids
//   3. Replay tried to apply old ids → target not found
//
// With the stable ID system:
//   1. Mutations logged with stableTargetId
//   2. VM reloads → EntityRegistry.bootstrap() maps new vmIds to same stableIds (by name)
//   3. applyMutation() resolves stableId → new vmId transparently ✓

const replayEngine = controller.getReplayEngine();
const rebuilt = await replayEngine.replay(log, projectJson);

console.log("Replay succeeded!");
console.log("Rebuilt targets:", controller.getTargets());

// ─── Round-trip validation ────────────────────────────────────────────────────

await controller.load(rebuilt);
const final = controller.serialize();

console.log(
  "Round trip equal:",
  JSON.stringify(rebuilt) === JSON.stringify(final),
);
