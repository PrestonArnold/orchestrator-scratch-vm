import { EntityRegistry } from "./EntityRegistry";
import { MutationLog } from "./MutationLog";
import { ReplayEngine } from "./ReplayEngine";
import { StableEntityId } from "./StableEntityId";
import { ProjectJSON, ScratchTarget, ScratchVMRuntime, VMOperation } from "./types";
import { CanonicalDiff, CanonicalProject } from "./canonical/types";
import { ProjectSerializer } from "./canonical/ProjectSerializer";
import { ProjectDeserializer } from "./canonical/ProjectDeserializer";
import { ProjectDiffer } from "./canonical/ProjectDiffer";

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
      return this;
    }

    this.project = structuredClone(project);
    await this.vm.loadProject(JSON.stringify(project));
    this.registry.bootstrap(this.vm.runtime.targets);

    return this;
  }

  /**
   * Load the VM from a CanonicalProject snapshot.
   *
   * Preferred over load() when restoring from a git checkout or any
   * canonical source, because it preserves the stable IDs embedded in
   * the snapshot rather than minting new ones.
   *
   * Sequence:
   *   1. Seed registry.nameToStable from canonical stableIds (before load)
   *   2. Deserialize canonical → VM JSON
   *   3. load(vmJson) → vm.loadProject() + registry.bootstrap()
   *
   * bootstrap() clears stableToVm/vmToStable but keeps nameToStable, so
   * the seed in step 1 survives and reconnects the correct IDs by name.
   */
  async loadCanonical(project: CanonicalProject): Promise<this> {
    // Step 1: seed stable IDs so bootstrap() reconnects them correctly
    this.registry.bootstrapFromCanonical(project.targets);
    // Step 2+3: deserialize → load (calls bootstrap() internally)
    const vmJson = new ProjectDeserializer().deserialize(project);
    return this.load(vmJson);
  }

  applyMutation(op: VMOperation): void {
    const target = this.resolveTarget(op.stableTargetId);

    switch (op.type) {

      // ─── Target mutations ───────────────────────────────────────────────

      case "TARGET_MOVE": {
        if (op.x !== undefined) target.x = op.x;
        if (op.y !== undefined) target.y = op.y;
        break;
      }

      case "TARGET_RENAME": {
        const oldName = target.sprite.name;
        target.sprite.name = op.name;
        this.registry.notifyRenamed(op.stableTargetId, oldName, op.name);
        break;
      }

      // ─── Variable mutations ──────────────────────────────────────────────

      case "ADD_VARIABLE": {
        if (target.variables[op.variableId]) {
          throw new Error(`Variable "${op.variableId}" already exists on target "${op.stableTargetId}"`);
        }
        // createVariable() constructs a real scratch-vm Variable instance so
        // vm.toJSON() serialises it correctly via .name/.value. Assigning a raw
        // array directly is silently ignored by toJSON() because it reads named
        // properties, not numeric indices — giving [null, null] after round-trip.
        // Variable.SCALAR_TYPE is '' (empty string) in scratch-vm.
        target.createVariable(op.variableId, op.name, "", op.cloud ?? false);
        if (op.value !== undefined) {
          target.variables[op.variableId].value = op.value;
        }
        break;
      }

      case "SET_VARIABLE": {
        const v = target.variables[op.variableId];
        if (!v) throw new Error(`Variable "${op.variableId}" not found on target "${op.stableTargetId}"`);
        // v is a Variable instance — use .value, not array index [1].
        v.value = op.value;
        break;
      }

      case "REMOVE_VARIABLE": {
        if (!target.variables[op.variableId]) {
          throw new Error(`Variable "${op.variableId}" not found on target "${op.stableTargetId}"`);
        }
        delete target.variables[op.variableId];
        break;
      }

      // ─── Block mutations ─────────────────────────────────────────────────

      case "ADD_BLOCK": {
        if (target.blocks.getBlock(op.blockId)) {
          throw new Error(`Block "${op.blockId}" already exists on target "${op.stableTargetId}"`);
        }
        target.blocks.createBlock({ id: op.blockId, ...op.block });
        break;
      }

      case "UPDATE_BLOCK_FIELD": {
        const block = target.blocks.getBlock(op.blockId);
        if (!block) throw new Error(`Block "${op.blockId}" not found on target "${op.stableTargetId}"`);
        block.fields ??= {};
        block.fields[op.field] = op.value;
        break;
      }

      case "REMOVE_BLOCK": {
        const block = target.blocks.getBlock(op.blockId);
        if (!block) throw new Error(`Block "${op.blockId}" not found on target "${op.stableTargetId}"`);
        target.blocks.deleteBlock(op.blockId);
        break;
      }

      default:
        throw new Error(`Unknown VM operation: ${(op as any).type}`);
    }

    // Record after successful application only
    this.log.record(op);
  }

  /**
   * Resolve a stableTargetId to a live VM target.
   * Throws with a clear message if either lookup fails.
   */
  private resolveTarget(stableTargetId: StableEntityId): ScratchTarget {
    const vmId = this.registry.resolveVmId(stableTargetId);
    if (vmId === undefined) {
      throw new Error(
        `EntityRegistry: no VM target for stable ID "${stableTargetId}". ` +
          `Make sure load() was called and the entity exists in this project.`,
      );
    }
    const target = this.vm.runtime.getTargetById(vmId);
    if (!target) {
      throw new Error(
        `VM has no target with id "${vmId}" (stable: "${stableTargetId}"). ` +
          `This is a registry/VM sync bug.`,
      );
    }
    return target;
  }

  // ─── Serialization ─────────────────────────────────────────────────────────

  /**
   * Export the current VM state as a plain object.
   * scratch-vm's toJSON() returns a JSON string — we always parse it here.
   */
  serialize(): ProjectJSON {
    if (!this.vm) throw new Error("VM instance not provided!");
    const raw = this.vm.toJSON();
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }

  /**
   * Export the current VM state as a CanonicalProject.
   * Preferred form for storage, diffing, and collaboration.
   */
  toCanonical(): CanonicalProject {
    const serializer = new ProjectSerializer(this.registry);
    return serializer.serialize(this.serialize());
  }

  /**
   * Diff the current VM state against a base CanonicalProject.
   */
  diffAgainst(base: CanonicalProject): CanonicalDiff {
    const differ = new ProjectDiffer();
    return differ.diff(base, this.toCanonical());
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  async roundTrip(project: ProjectJSON): Promise<{ equal: boolean }> {
    await this.load(project);
    const a = this.serialize();
    await this.load(a);
    const b = this.serialize();
    return { equal: JSON.stringify(a) === JSON.stringify(b) };
  }

  getTargets(): Array<{ stableId: StableEntityId; vmId: string; name: string }> {
    return this.registry.listEntities((id) => this.vm.runtime.getTargetById(id));
  }

  getVM(): ScratchVMRuntime { return this.vm; }
  getProject(): ProjectJSON | null { return this.project; }
  getMutationLog(): VMOperation[] { return this.log.getAll(); }
  getReplayEngine(): ReplayEngine { return new ReplayEngine(this); }
}
