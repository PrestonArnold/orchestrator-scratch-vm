import { ProjectJSON, ScratchVMRuntime, VMOperation } from "./types";

export class VMController {
  private vm: ScratchVMRuntime;
  private project: ProjectJSON | null = null;

  constructor(vmInstance: ScratchVMRuntime) {
    this.vm = vmInstance;
  }

  // Ensure VM is in clean, deterministic state
  async init() {
    if (!this.vm) throw new Error("VM instance not provided!");

    await this.vm.clear?.();

    return this;
  }

  // Load project into VM
  async load(project: ProjectJSON) {
    if (!this.vm) throw new Error("VM instance not provided!");

    await this.vm.clear?.();

    this.project = structuredClone(project);

    await this.vm.loadProject(project);

    return this;
  }

  // Apply controlled mutation to the VM state
  // Future: feed diff + collab layer
  applyMutation(op: VMOperation) {
    const runtime = this.vm.runtime;

    switch (op.type) {
      case "TARGET_MOVE": {
        const target = runtime.getTargetById(op.targetId);
        if (!target) throw new Error(`Target not found: ${op.targetId}`);

        if (op.x !== undefined) target.x = op.x;
        if (op.y !== undefined) target.y = op.y;

        break;
      }

      case "TARGET_RENAME": {
        const target = runtime.getTargetById(op.targetId);
        if (!target) throw new Error(`Target not found: ${op.targetId}`);

        target.sprite.name = op.name;
        break;
      }

      case "BLOCK_SET_VALUE": {
        const target = runtime.getTargetById(op.targetId);
        if (!target) throw new Error(`Target not found: ${op.targetId}`);

        const block = target.blocks.getBlock(op.blockId);
        if (!block) throw new Error(`Block not found: ${op.blockId}`);

        if (!block.fields) block.fields = {};
        block.fields[op.field] = op.value;

        break;
      }

      default:
        throw new Error(`Unknown VM operation!`);
    }
  }

  // Export VM state -> project JSON (canonical snapshot of state)
  serialize(): ProjectJSON {
    if (!this.vm) throw new Error("VM instance not provided!");

    const project = this.vm.toJSON();

    this.project = structuredClone(project);

    return project;
  }

  // Round trip correctness check
  // This isn't good at all, but it's a start
  async roundTrip(project: ProjectJSON) {
    await this.load(project);

    const firstRaw = this.serialize();
    await this.load(firstRaw);
    const first = JSON.stringify(firstRaw);

    const secondRaw = this.serialize();
    const second = JSON.stringify(secondRaw);

    return {
      first,
      second,
      equal: first === second,
    };
  }

  getVM() {
    return this.vm;
  }

  getProject() {
    return this.project;
  }
}
