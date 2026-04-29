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
      case "TARGET_MOVE":
        const target = runtime.getTargetById(op.targetId);
    }
  }
}
