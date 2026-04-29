import {
  mintStableEntityId,
  STAGE_STABLE_ID,
  StableEntityId,
} from "./StableEntityId";
import { ScratchTarget } from "./types";

export class EntityRegistry {
  private stableToVm = new Map<StableEntityId, string>();

  private vmToStable = new Map<string, StableEntityId>();

  private nameToStable = new Map<string, StableEntityId>();

  bootstrap(targets: ScratchTarget[]): void {
    // Only clear the per-session maps; nameToStable is intentionally persistent.
    this.stableToVm.clear();
    this.vmToStable.clear();

    for (const target of targets) {
      if ((target as any).isStage) {
        this.stableToVm.set(STAGE_STABLE_ID, target.id);
        this.vmToStable.set(target.id, STAGE_STABLE_ID);
        continue;
      }

      const name = target.sprite?.name;
      if (!name) continue;

      let stableId = this.nameToStable.get(name);
      if (!stableId) {
        stableId = mintStableEntityId();
        this.nameToStable.set(name, stableId);
      }

      this.stableToVm.set(stableId, target.id);
      this.vmToStable.set(target.id, stableId);
    }
  }

  resolveVmId(stableId: StableEntityId): string | undefined {
    return this.stableToVm.get(stableId);
  }

  resolveStableId(vmId: string): StableEntityId | undefined {
    return this.vmToStable.get(vmId);
  }

  notifyRenamed(
    stableId: StableEntityId,
    oldName: string,
    newName: string,
  ): void {
    this.nameToStable.set(oldName, stableId);
    this.nameToStable.set(newName, stableId);
  }

  listEntities(
    getTargetById?: (vmId: string) => { sprite?: { name: string } } | undefined,
  ): Array<{
    stableId: StableEntityId;
    vmId: string;
    name: string;
  }> {
    const result: Array<{
      stableId: StableEntityId;
      vmId: string;
      name: string;
    }> = [];

    for (const [stableId, vmId] of this.stableToVm) {
      if (stableId === STAGE_STABLE_ID) continue;

      // Prefer the live VM name (accurate after renames); fall back to
      // the most recently recorded name in nameToStable.
      let name = "unknown";
      if (getTargetById) {
        const t = getTargetById(vmId);
        if (t?.sprite?.name) name = t.sprite.name;
      }
      if (name === "unknown") {
        // Walk nameToStable to find a name for this stableId.
        for (const [n, sid] of this.nameToStable) {
          if (sid === stableId) {
            name = n;
            break;
          }
        }
      }

      result.push({ stableId, vmId, name });
    }

    // include stage
    const stageVmId = this.stableToVm.get(STAGE_STABLE_ID);
    if (stageVmId !== undefined) {
      result.push({
        stableId: STAGE_STABLE_ID,
        vmId: stageVmId,
        name: "_stage_",
      });
    }

    return result;
  }

  // Debug dump
  // never use this for logic
  debug(): {
    stableToVm: Record<string, string>;
    nameToStable: Record<string, string>;
  } {
    return {
      stableToVm: Object.fromEntries(this.stableToVm),
      nameToStable: Object.fromEntries(this.nameToStable),
    };
  }
}
