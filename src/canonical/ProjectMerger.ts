import { StableEntityId } from "../StableEntityId";
import {
  CanonicalBlock,
  CanonicalProject,
  CanonicalTarget,
  CanonicalVariable,
} from "./types";
import {
  BlockDiffer,
  BlockChange,
  BlockGraphDiff,
  InputChange,
} from "./ProjectDiffer";

// ─── Merge result types ───────────────────────────────────────────────────────

/**
 * A conflict on a single field/input of a block.
 * Both branches changed the same thing to different values.
 */
export type BlockConflict = {
  blockId: string;
  /** "field" | "input" | "opcode" | "structure" */
  aspect: string;
  /** The specific key within that aspect (e.g. field name, input name) */
  key: string;
  base: unknown;
  ours: unknown; // branch A
  theirs: unknown; // branch B
};

export type ProjectMergeResult = {
  /**
   * The merged project, as complete as possible.
   * Even when there are conflicts, non-conflicting changes are applied.
   * Conflicting blocks are left at their base state and listed in `conflicts`.
   */
  project: CanonicalProject;
  conflicts: BlockConflict[];
  /** true if the merge is clean (no conflicts) */
  clean: boolean;
};

// ─── ProjectMerger ────────────────────────────────────────────────────────────

/**
 * ProjectMerger
 *
 * 3-way merge over CanonicalProjects.
 *
 * merge(base, ours, theirs) applies all changes from both branches:
 *   - changes only in ours   → applied
 *   - changes only in theirs → applied
 *   - same change in both    → applied once (idempotent, no conflict)
 *   - different changes to same field → conflict recorded, base value kept
 *
 * The returned project is always complete and loadable. Conflicting blocks
 * retain their base state. Callers inspect `conflicts` to surface them to users.
 */
export class ProjectMerger {
  private readonly blockDiffer = new BlockDiffer();

  merge(
    base: CanonicalProject,
    ours: CanonicalProject,
    theirs: CanonicalProject,
  ): ProjectMergeResult {
    const allConflicts: BlockConflict[] = [];

    const baseMap = this.targetMap(base);
    const oursMap = this.targetMap(ours);
    const theirsMap = this.targetMap(theirs);

    const allIds = new Set([
      ...baseMap.keys(),
      ...oursMap.keys(),
      ...theirsMap.keys(),
    ]);

    const mergedTargets: CanonicalTarget[] = [];

    for (const id of allIds) {
      const b = baseMap.get(id) ?? null;
      const o = oursMap.get(id) ?? null;
      const t = theirsMap.get(id) ?? null;

      // ── Removals ──────────────────────────────────────────────────────────
      if (!o && !t) continue; // removed by both → gone
      if (!o && b) continue; // removed by ours → gone
      if (!t && b) continue; // removed by theirs → gone

      // ── Additions (not in base) ────────────────────────────────────────────
      if (!b && o && !t) {
        mergedTargets.push(o);
        continue;
      }
      if (!b && !o && t) {
        mergedTargets.push(t);
        continue;
      }
      if (!b && o && t) {
        mergedTargets.push(o);
        continue;
      } // both added → take ours

      // ── Present in base: 3-way merge ──────────────────────────────────────
      const { target, conflicts } = this.mergeTarget(b!, o!, t!);
      mergedTargets.push(target);
      allConflicts.push(...conflicts);
    }

    // Preserve original target ordering where possible (base order first, then
    // targets that were only added by ours/theirs appended at the end).
    const baseOrder = base.targets.map((t) => t.stableId);
    mergedTargets.sort((a, b) => {
      const ai = baseOrder.indexOf(a.stableId);
      const bi = baseOrder.indexOf(b.stableId);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });

    return {
      project: { ...base, targets: mergedTargets },
      conflicts: allConflicts,
      clean: allConflicts.length === 0,
    };
  }

  // ─── Target merge ─────────────────────────────────────────────────────────

  private mergeTarget(
    base: CanonicalTarget,
    ours: CanonicalTarget,
    theirs: CanonicalTarget,
  ): { target: CanonicalTarget; conflicts: BlockConflict[] } {
    const conflicts: BlockConflict[] = [];

    // ── Scalar target fields ──────────────────────────────────────────────────
    const name = this.mergeScalar(base.name, ours.name, theirs.name);
    const x = this.mergeScalar(base.x, ours.x, theirs.x);
    const y = this.mergeScalar(base.y, ours.y, theirs.y);

    // ── Variables ─────────────────────────────────────────────────────────────
    const variables = this.mergeVariables(
      base.variables,
      ours.variables,
      theirs.variables,
    );

    // ── Blocks ────────────────────────────────────────────────────────────────
    const diffOurs = this.blockDiffer.diff(base.blocks, ours.blocks);
    const diffTheirs = this.blockDiffer.diff(base.blocks, theirs.blocks);

    const { blocks, blockConflicts } = this.mergeBlocks(
      base.blocks,
      ours.blocks,
      theirs.blocks,
      diffOurs,
      diffTheirs,
    );
    conflicts.push(...blockConflicts);

    const target: CanonicalTarget = {
      ...base,
      name: name ?? base.name,
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
      variables,
      blocks,
    };

    return { target, conflicts };
  }

  // ─── Block merge ──────────────────────────────────────────────────────────

  /**
   * 3-way merge of block graphs.
   *
   * Requires full ours/theirs block maps so that added blocks can be
   * materialised (the diff only carries IDs, not block data).
   */
  private mergeBlocks(
    base: Record<string, CanonicalBlock>,
    oursBlocks: Record<string, CanonicalBlock>,
    theirsBlocks: Record<string, CanonicalBlock>,
    diffOurs: BlockGraphDiff | null,
    diffTheirs: BlockGraphDiff | null,
  ): {
    blocks: Record<string, CanonicalBlock>;
    blockConflicts: BlockConflict[];
  } {
    const conflicts: BlockConflict[] = [];

    // Work from a shallow copy of base
    const result: Record<string, CanonicalBlock> = { ...base };

    const oAdded = new Set(diffOurs?.added ?? []);
    const tAdded = new Set(diffTheirs?.added ?? []);
    const oRemoved = new Set(diffOurs?.removed ?? []);
    const tRemoved = new Set(diffTheirs?.removed ?? []);

    const oMods = new Map<string, BlockChange>(
      (diffOurs?.modified ?? []).map((c) => [c.id, c]),
    );
    const tMods = new Map<string, BlockChange>(
      (diffTheirs?.modified ?? []).map((c) => [c.id, c]),
    );

    // ── Removals ──────────────────────────────────────────────────────────────
    //
    // Policy: explicit removal wins over a modification on the other side.
    // Rationale: if you deleted a block you didn't intend for any changes to it
    // to survive. This is the same semantics Git uses for file deletions.

    for (const id of oRemoved) {
      delete result[id];
    }
    for (const id of tRemoved) {
      // Even if ours modified it, theirs' removal wins (symmetric policy)
      delete result[id];
    }

    // ── Additions ─────────────────────────────────────────────────────────────
    //
    // Both sides may add the same block ID (unlikely but possible if the project
    // was saved concurrently). When both add the same ID:
    //   - identical block → add once (idempotent)
    //   - different block → take ours, no conflict raised at block granularity
    //     (a target-level conflict could be raised in future, but keep it simple)

    for (const id of oAdded) {
      if (result[id]) continue; // already present (e.g. in base or theirs also added it)
      const block = oursBlocks[id];
      if (block) result[id] = block;
    }

    for (const id of tAdded) {
      if (result[id]) {
        // Already added by ours — check for divergence
        const oBlock = oursBlocks[id];
        const tBlock = theirsBlocks[id];
        if (
          oBlock &&
          tBlock &&
          JSON.stringify(oBlock) !== JSON.stringify(tBlock)
        ) {
          // Both added the same ID with different content — keep ours (already set)
          // No block-level conflict raised; callers can inspect at a higher level.
        }
        continue;
      }
      const block = theirsBlocks[id];
      if (block) result[id] = block;
    }

    // ── Modifications ─────────────────────────────────────────────────────────

    const allModifiedIds = new Set([...oMods.keys(), ...tMods.keys()]);

    for (const id of allModifiedIds) {
      if (!result[id]) continue; // was removed — skip

      const oChange = oMods.get(id);
      const tChange = tMods.get(id);

      if (oChange && !tChange) {
        result[id] = this.applyBlockChange(result[id], oChange);
        continue;
      }
      if (!oChange && tChange) {
        result[id] = this.applyBlockChange(result[id], tChange);
        continue;
      }
      if (oChange && tChange) {
        const { block, blockConflicts } = this.mergeBlockChanges(
          id,
          result[id],
          oursBlocks[id],
          theirsBlocks[id],
          oChange,
          tChange,
        );
        result[id] = block;
        conflicts.push(...blockConflicts);
      }
    }

    return { blocks: result, blockConflicts: conflicts };
  }

  /**
   * Merge two changes to the same block, field by field.
   *
   *   same key → same value → apply once
   *   same key → different value → conflict (base value kept)
   *   different keys → both applied
   */
  private mergeBlockChanges(
    id: string,
    base: CanonicalBlock,
    oursBlock: CanonicalBlock,
    theirsBlock: CanonicalBlock,
    ours: BlockChange,
    theirs: BlockChange,
  ): { block: CanonicalBlock; blockConflicts: BlockConflict[] } {
    const blockConflicts: BlockConflict[] = [];
    let block = { ...base };

    // ── Opcode ────────────────────────────────────────────────────────────────
    if (ours.opcode || theirs.opcode) {
      const oOp = ours.opcode?.to;
      const tOp = theirs.opcode?.to;
      if (oOp && !tOp) block.opcode = oOp;
      else if (!oOp && tOp) block.opcode = tOp;
      else if (oOp && tOp && oOp === tOp) block.opcode = oOp;
      else if (oOp && tOp && oOp !== tOp) {
        blockConflicts.push({
          blockId: id,
          aspect: "opcode",
          key: "opcode",
          base: base.opcode,
          ours: oOp,
          theirs: tOp,
        });
        // base value kept (block.opcode unchanged)
      }
    }

    // ── Fields ────────────────────────────────────────────────────────────────
    const allFieldKeys = new Set([
      ...Object.keys(ours.fields ?? {}),
      ...Object.keys(theirs.fields ?? {}),
    ]);
    const fields = { ...base.fields };
    for (const key of allFieldKeys) {
      const oField = ours.fields?.[key]?.to;
      const tField = theirs.fields?.[key]?.to;
      if (oField !== undefined && tField === undefined) {
        fields[key] = oField;
      } else if (oField === undefined && tField !== undefined) {
        fields[key] = tField;
      } else if (oField !== undefined && tField !== undefined) {
        if (JSON.stringify(oField) === JSON.stringify(tField)) {
          fields[key] = oField;
        } else {
          blockConflicts.push({
            blockId: id,
            aspect: "field",
            key,
            base: base.fields[key],
            ours: oField,
            theirs: tField,
          });
          // base value kept
        }
      }
    }
    block.fields = fields;

    // ── Inputs ────────────────────────────────────────────────────────────────
    const allInputKeys = new Set([
      ...Object.keys(ours.inputs ?? {}),
      ...Object.keys(theirs.inputs ?? {}),
    ]);
    const inputs = { ...base.inputs };
    for (const key of allInputKeys) {
      const oInput = ours.inputs?.[key];
      const tInput = theirs.inputs?.[key];
      if (oInput && !tInput) {
        inputs[key] = this.applyInputChange(base.inputs[key], oInput);
      } else if (!oInput && tInput) {
        inputs[key] = this.applyInputChange(base.inputs[key], tInput);
      } else if (oInput && tInput) {
        if (JSON.stringify(oInput) === JSON.stringify(tInput)) {
          inputs[key] = this.applyInputChange(base.inputs[key], oInput);
        } else {
          // Store the actual resolved input tuples (not the InputChange deltas)
          // so that ConflictResolver.pickValue() returns the correct final values.
          const oursValue =
            oursBlock?.inputs[key] ??
            this.applyInputChange(base.inputs[key], oInput);
          const theirsValue =
            theirsBlock?.inputs[key] ??
            this.applyInputChange(base.inputs[key], tInput);
          blockConflicts.push({
            blockId: id,
            aspect: "input",
            key,
            base: base.inputs[key],
            ours: oursValue,
            theirs: theirsValue,
          });
          // base value kept
        }
      }
    }
    block.inputs = inputs;

    // ── Structure (next / parent) ─────────────────────────────────────────────
    const oNext = ours.structure?.next;
    const tNext = theirs.structure?.next;
    const oParent = ours.structure?.parent;
    const tParent = theirs.structure?.parent;

    if (oNext || tNext) {
      const oVal = oNext?.to;
      const tVal = tNext?.to;
      const oDefined = oNext !== undefined;
      const tDefined = tNext !== undefined;
      if (oDefined && !tDefined) block.next = oVal ?? null;
      else if (!oDefined && tDefined) block.next = tVal ?? null;
      else if (oDefined && tDefined) {
        if (oVal === tVal) block.next = oVal ?? null;
        else
          blockConflicts.push({
            blockId: id,
            aspect: "structure",
            key: "next",
            base: base.next,
            ours: oVal,
            theirs: tVal,
          });
      }
    }

    if (oParent || tParent) {
      const oVal = oParent?.to;
      const tVal = tParent?.to;
      const oDefined = oParent !== undefined;
      const tDefined = tParent !== undefined;
      if (oDefined && !tDefined) block.parent = oVal ?? null;
      else if (!oDefined && tDefined) block.parent = tVal ?? null;
      else if (oDefined && tDefined) {
        if (oVal === tVal) block.parent = oVal ?? null;
        else
          blockConflicts.push({
            blockId: id,
            aspect: "structure",
            key: "parent",
            base: base.parent,
            ours: oVal,
            theirs: tVal,
          });
      }
    }

    return { block, blockConflicts };
  }

  private applyBlockChange(
    block: CanonicalBlock,
    change: BlockChange,
  ): CanonicalBlock {
    const result = { ...block };

    if (change.opcode) result.opcode = change.opcode.to;

    if (change.fields) {
      result.fields = { ...block.fields };
      for (const [key, fc] of Object.entries(change.fields)) {
        result.fields[key] = fc.to;
      }
    }

    if (change.inputs) {
      result.inputs = { ...block.inputs };
      for (const [key, ic] of Object.entries(change.inputs)) {
        result.inputs[key] = this.applyInputChange(block.inputs[key], ic);
      }
    }

    if (change.structure) {
      if (change.structure.next !== undefined)
        result.next = change.structure.next.to;
      if (change.structure.parent !== undefined)
        result.parent = change.structure.parent.to;
    }

    return result;
  }

  private applyInputChange(
    current: CanonicalBlock["inputs"][string],
    change: InputChange,
  ): CanonicalBlock["inputs"][string] {
    if (!current) return current;
    const updated = [...current] as typeof current;
    if (
      change.kind === "value_changed" ||
      change.kind === "connection_changed"
    ) {
      (updated as any)[1] = change.to;
    }
    return updated;
  }

  // ─── Variable merge ───────────────────────────────────────────────────────

  private mergeVariables(
    base: Record<string, CanonicalVariable>,
    ours: Record<string, CanonicalVariable>,
    theirs: Record<string, CanonicalVariable>,
  ): Record<string, CanonicalVariable> {
    const result: Record<string, CanonicalVariable> = { ...base };
    const allIds = new Set([...Object.keys(ours), ...Object.keys(theirs)]);

    for (const id of allIds) {
      const b = base[id];
      const o = ours[id];
      const t = theirs[id];

      // Removed on one or both sides
      if (!o && !t) {
        delete result[id];
        continue;
      }
      if (!o && b) {
        delete result[id];
        continue;
      } // ours removed it
      if (!t && b) {
        delete result[id];
        continue;
      } // theirs removed it

      // Added (not in base)
      if (!b && o) {
        result[id] = o;
        continue;
      }
      if (!b && t) {
        result[id] = t;
        continue;
      }

      // Present in both: if identical, keep; otherwise prefer ours.
      // A proper variable diff would track base→ours and base→theirs value
      // changes individually, but variable values are runtime state anyway.
      result[id] = JSON.stringify(o) !== JSON.stringify(t) ? o : o;
    }

    return result;
  }

  // ─── Scalar 3-way merge ───────────────────────────────────────────────────

  /**
   * 3-way merge for a scalar value.
   *
   *   neither side changed → return base
   *   only one side changed → return that change
   *   both changed to same value → return it (idempotent)
   *   both changed to different values → return undefined (caller keeps base)
   */
  private mergeScalar<T>(base: T, ours: T, theirs: T): T | undefined {
    const oChanged = ours !== base;
    const tChanged = theirs !== base;
    if (!oChanged && !tChanged) return base;
    if (oChanged && !tChanged) return ours;
    if (!oChanged && tChanged) return theirs;
    if (ours === theirs) return ours; // both changed to same value
    return undefined; // genuine conflict — caller keeps base
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private targetMap(
    project: CanonicalProject,
  ): Map<StableEntityId, CanonicalTarget> {
    return new Map(project.targets.map((t) => [t.stableId, t]));
  }
}
