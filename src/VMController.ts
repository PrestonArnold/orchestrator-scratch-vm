import { EntityRegistry } from "./EntityRegistry";
import { MutationLog } from "./MutationLog";
import { ReplayEngine } from "./ReplayEngine";
import { StableEntityId } from "./StableEntityId";
import { ProjectJSON, ScratchVMRuntime, VMOperation } from "./types";

export class VMController {
  private vm: ScratchVMRuntime;
  private project: ProjectJSON | null = null;
  private log = new MutationLog();

  readonly registry = new EntityRegistry();

  constructor(vmInstance: ScratchVMRuntime) {
    this.vm = vmInstance;
  }

  async load(project: ProjectJSON | null): Promise<this> {
    if (!this.vm) throw new Error("VM instance not provided!");

    await this.vm.clear?.();

    if (!project) {
      this.project = null;
      // Registry session maps are stale; nameToStable intentionally persists
      // so that a subsequent load of the same project reconnects stable IDs.
      return this;
    }

    this.project = structuredClone(project);
    await this.vm.loadProject(project);

    // Rebuild stable <-> vm mappings now that the VM has live targets.
    this.registry.bootstrap(this.vm.runtime.targets);

    return this;
  }

  applyMutation(op: VMOperation): void {
    // Resolve stableTargetId -> current vmId
    const vmId = this.registry.resolveVmId(op.stableTargetId);
    if (vmId === undefined) {
      throw new Error(
        `EntityRegistry: no VM target for stable ID "${op.stableTargetId}". ` +
          `Make sure load() was called and the entity exists in this project.`,
      );
    }

    const target = this.vm.runtime.getTargetById(vmId);
    if (!target) {
      throw new Error(
        `VM has no target with id "${vmId}" (stable: "${op.stableTargetId}"). ` +
          `This is a registry/VM sync bug.`,
      );
    }

    switch (op.type) {
      case "TARGET_MOVE": {
        if (op.x !== undefined) target.x = op.x;
        if (op.y !== undefined) target.y = op.y;
        break;
      }

      case "TARGET_RENAME": {
        const oldName = target.sprite.name;
        target.sprite.name = op.name;
        // Keep registry in sync so the next bootstrap() reconnects correctly.
        this.registry.notifyRenamed(op.stableTargetId, oldName, op.name);
        break;
      }

      case "BLOCK_SET_VALUE": {
        const block = target.blocks.getBlock(op.blockId);
        if (!block) throw new Error(`Block not found: ${op.blockId}`);

        block.fields ??= {};
        block.fields[op.field] = op.value;
        break;
      }

      default:
        throw new Error(`Unknown VM operation: ${(op as any).type}`);
    }

    // Only record after successful application.
    this.log.record(op);
  }

  /** Export the current VM state as a project JSON. */
  serialize(): ProjectJSON {
    if (!this.vm) throw new Error("VM instance not provided!");
    return this.vm.toJSON();
  }

  /** Verify that serialize -> reload -> serialize produces identical output. */
  async roundTrip(project: ProjectJSON): Promise<{ equal: boolean }> {
    await this.load(project);
    const a = this.serialize();

    await this.load(a);
    const b = this.serialize();

    return { equal: JSON.stringify(a) === JSON.stringify(b) };
  }

  /** Return all currently-loaded entities with their stable IDs. */
  getTargets(): Array<{
    stableId: StableEntityId;
    vmId: string;
    name: string;
  }> {
    return this.registry.listEntities((id) =>
      this.vm.runtime.getTargetById(id),
    );
  }

  getVM(): ScratchVMRuntime {
    return this.vm;
  }

  getProject(): ProjectJSON | null {
    return this.project;
  }

  getMutationLog(): VMOperation[] {
    return this.log.getAll();
  }

  getReplayEngine(): ReplayEngine {
    return new ReplayEngine(this);
  }
}
