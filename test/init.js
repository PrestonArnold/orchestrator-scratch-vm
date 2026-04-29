import fs from "node:fs/promises";
import JSZip from "jszip";

import VM from "scratch-vm";
import { VMController } from "../dist/index.js";

// -----------------------------
// Boot VM + Controller
// -----------------------------
const vm = new VM();
const controller = new VMController(vm);

await vm.start();
await controller.init();

// -----------------------------
// Load SB3
// -----------------------------
const sb3Buffer = await fs.readFile("examples/default.sb3");

const zip = await JSZip.loadAsync(sb3Buffer);

const projectJsonRaw = await zip.file("project.json").async("string");
const projectJson = JSON.parse(projectJsonRaw);

// -----------------------------
// Load into VM
// -----------------------------
await controller.load(projectJson);

console.log("Project loaded");

// -----------------------------
// 🔥 TARGET RESOLVER (MVP LOCAL ONLY)
// -----------------------------
function getSpriteTarget(vm, nameHint = null) {
  const targets = vm.runtime.targets;

  // If name provided, match by sprite name
  if (nameHint) {
    const found = targets.find(
      (t) => !t.isStage && t.sprite?.name === nameHint,
    );
    if (found) return found;
  }

  // fallback: first non-stage sprite
  return targets.find((t) => !t.isStage);
}

// -----------------------------
// Inspect runtime (debug step)
// -----------------------------
console.log(
  "Targets:",
  vm.runtime.targets.map((t) => ({
    id: t.id,
    name: t.sprite?.name,
    isStage: t.isStage,
  })),
);

// -----------------------------
// Resolve real target
// -----------------------------
const sprite = getSpriteTarget(vm, "Sprite1");

if (!sprite) {
  throw new Error("No sprite found in project");
}

console.log("Using sprite:", sprite.id);

// -----------------------------
// Apply mutations using REAL ID
// -----------------------------
controller.applyMutation({
  type: "TARGET_MOVE",
  targetId: sprite.id,
  x: 120,
  y: 80,
});

controller.applyMutation({
  type: "TARGET_RENAME",
  targetId: sprite.id,
  name: "MySprite",
});

// -----------------------------
// Export snapshot
// -----------------------------
const out = controller.serialize();

console.log("After mutation:");
console.log(out);

// -----------------------------
// Round-trip validation (MVP gate)
// -----------------------------
await controller.load(out);

const final = controller.serialize();

console.log("Round trip equal:", JSON.stringify(out) === JSON.stringify(final));
