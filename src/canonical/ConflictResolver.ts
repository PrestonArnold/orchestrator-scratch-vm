import {
  CanonicalBlock,
  CanonicalBlockField,
  CanonicalBlockInput,
  CanonicalProject,
} from "./types";
import { BlockConflict, ProjectMergeResult } from "./ProjectMerger";

// ─── Resolution types ─────────────────────────────────────────────────────────

/**
 * Which value to accept when resolving a conflict.
 *
 * Each arm is its own discriminant so TypeScript can narrow correctly:
 *
 *   { pick: "ours" }             → take branch A's value
 *   { pick: "theirs" }           → take branch B's value
 *   { pick: "base" }             → revert to common ancestor value
 *   { pick: "custom"; value: T } → supply an arbitrary replacement value
 */
export type Resolution =
  | { pick: "ours" }
  | { pick: "theirs" }
  | { pick: "base" }
  | { pick: "custom"; value: unknown };

/**
 * A map of resolutions keyed by conflict identity.
 * Key format: `<blockId>/<aspect>/<key>`  (e.g. "aaa/input/STEPS")
 */
export type ResolutionMap = Map<string, Resolution>;

/**
 * A single conflict with its stable string key pre-computed.
 */
export type IndexedConflict = BlockConflict & {
  /** Stable key used to address this conflict in a ResolutionMap. */
  id: string;
};

// ─── ResolvedMergeResult ──────────────────────────────────────────────────────

export type ResolvedMergeResult = {
  project: CanonicalProject;
  /** Conflicts that were NOT given a resolution (still pending). */
  unresolved: IndexedConflict[];
  /** How many conflicts were resolved programmatically. */
  resolvedCount: number;
  /** true when unresolved.length === 0 */
  clean: boolean;
};

// ─── ConflictResolver ─────────────────────────────────────────────────────────

/**
 * ConflictResolver
 *
 * Applies a ResolutionMap to a ProjectMergeResult to produce a fully-resolved
 * (or partially-resolved) project.
 *
 * Stateless — safe to call repeatedly with different resolution maps.
 *
 * Usage:
 *
 *   const merger   = new ProjectMerger();
 *   const resolver = new ConflictResolver();
 *
 *   const merged = merger.merge(base, ours, theirs);
 *
 *   if (!merged.clean) {
 *     const indexed = resolver.index(merged);
 *     indexed.forEach(c => console.log(c.id, c.aspect, c.key));
 *
 *     const resolutions: ResolutionMap = new Map([
 *       ["aaa/input/STEPS",    { pick: "ours" }],
 *       ["bbb/opcode/opcode",  { pick: "theirs" }],
 *     ]);
 *
 *     const resolved = resolver.resolve(merged, resolutions);
 *   }
 *
 * Partial resolution:
 *   Pass only a subset of resolutions. `resolved.unresolved` lists the rest.
 *   Unresolved conflicts keep the base value (safe fallback).
 */
export class ConflictResolver {
  /**
   * Index the conflicts in a merge result, attaching stable string IDs.
   * Call this first to discover what needs resolution.
   */
  index(result: ProjectMergeResult): IndexedConflict[] {
    return result.conflicts.map((c) => ({
      ...c,
      id: conflictKey(c),
    }));
  }

  /**
   * Apply resolutions to a merge result.
   *
   * The returned project is always complete and loadable.
   * Unresolved conflicts keep the base value (already the merger's fallback).
   */
  resolve(
    result: ProjectMergeResult,
    resolutions: ResolutionMap,
  ): ResolvedMergeResult {
    const indexed = this.index(result);
    const unresolved: IndexedConflict[] = [];
    let resolvedCount = 0;

    // Group patches by block ID so we apply all at once per block.
    const patchesByBlock = new Map<string, Map<string, unknown>>();

    for (const conflict of indexed) {
      const resolution = resolutions.get(conflict.id);
      if (!resolution) {
        unresolved.push(conflict);
        continue;
      }

      const value = this.pickValue(conflict, resolution);
      let blockPatches = patchesByBlock.get(conflict.blockId);
      if (!blockPatches) {
        blockPatches = new Map();
        patchesByBlock.set(conflict.blockId, blockPatches);
      }
      blockPatches.set(`${conflict.aspect}/${conflict.key}`, value);
      resolvedCount++;
    }

    const project = this.applyPatches(result.project, patchesByBlock);

    return {
      project,
      unresolved,
      resolvedCount,
      clean: unresolved.length === 0,
    };
  }

  /**
   * Resolve all conflicts at once with a single bulk strategy.
   *
   *   resolver.resolveAll(result, "ours")   → accept all ours values
   *   resolver.resolveAll(result, "theirs") → accept all theirs values
   *   resolver.resolveAll(result, "base")   → revert all to base
   */
  resolveAll(
    result: ProjectMergeResult,
    strategy: "ours" | "theirs" | "base",
  ): ResolvedMergeResult {
    const map: ResolutionMap = new Map(
      result.conflicts.map((c) => [conflictKey(c), { pick: strategy } as Resolution]),
    );
    return this.resolve(result, map);
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private pickValue(conflict: BlockConflict, resolution: Resolution): unknown {
    switch (resolution.pick) {
      case "ours":   return conflict.ours;
      case "theirs": return conflict.theirs;
      case "base":   return conflict.base;
      case "custom": return resolution.value; // narrowed correctly by switch
    }
  }

  private applyPatches(
    project: CanonicalProject,
    patchesByBlock: Map<string, Map<string, unknown>>,
  ): CanonicalProject {
    if (patchesByBlock.size === 0) return project;

    const targets = project.targets.map((target) => {
      const relevantIds = Object.keys(target.blocks).filter((id) => patchesByBlock.has(id));
      if (relevantIds.length === 0) return target;

      const blocks = { ...target.blocks };
      for (const blockId of relevantIds) {
        blocks[blockId] = this.patchBlock(blocks[blockId], patchesByBlock.get(blockId)!);
      }
      return { ...target, blocks };
    });

    return { ...project, targets };
  }

  /**
   * Apply a set of resolved patches to a single block.
   * Patch keys are "aspect/key"; values are the chosen resolved values.
   */
  private patchBlock(
    block: CanonicalBlock,
    patches: Map<string, unknown>,
  ): CanonicalBlock {
    let result = { ...block };

    for (const [aspectKey, value] of patches) {
      const slashIdx = aspectKey.indexOf("/");
      const aspect   = aspectKey.slice(0, slashIdx);
      const key      = aspectKey.slice(slashIdx + 1);

      switch (aspect) {
        case "opcode":
          result.opcode = value as string;
          break;
        case "field":
          result.fields = { ...result.fields, [key]: value as CanonicalBlockField };
          break;
        case "input": {
          // If value is a full CanonicalBlockInput (array whose first element is
          // the numeric input-mode), write it directly.  Otherwise treat it as
          // the inner primitive and splice it into slot [1] of the existing input.
          const existing = result.inputs[key];
          const isFullInput =
            Array.isArray(value) &&
            value.length >= 2 &&
            typeof (value as any[])[0] === "number" &&
            Array.isArray((value as any[])[1]);
          if (isFullInput) {
            result.inputs = { ...result.inputs, [key]: value as CanonicalBlockInput };
          } else if (existing) {
            const updated = [...existing] as typeof existing;
            (updated as any)[1] = value;
            result.inputs = { ...result.inputs, [key]: updated };
          } else {
            result.inputs = { ...result.inputs, [key]: value as CanonicalBlockInput };
          }
          break;
        }
        case "structure":
          if (key === "next")   result.next   = value as string | null;
          if (key === "parent") result.parent = value as string | null;
          break;
      }
    }

    return result;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Stable, human-readable key for a conflict.
 * Format: "<blockId>/<aspect>/<key>"  e.g. "aaa/input/STEPS"
 */
export function conflictKey(c: Pick<BlockConflict, "blockId" | "aspect" | "key">): string {
  return `${c.blockId}/${c.aspect}/${c.key}`;
}
