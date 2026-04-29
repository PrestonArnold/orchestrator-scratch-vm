import { StableEntityId } from "../StableEntityId";
import {
  BlocksDiff,
  CanonicalBlock,
  CanonicalDiff,
  CanonicalProject,
  CanonicalTarget,
  CanonicalVariable,
  TargetDiff,
  VariablesDiff,
} from "./types";

/**
 * ProjectDiffer
 *
 * Computes the structural diff between two CanonicalProjects.
 *
 * This is the foundation for:
 *   - "what changed in this commit"
 *   - PR reviews (base vs head)
 *   - conflict detection in collaboration
 *   - branch divergence summaries
 *
 * Identity: targets are matched by stableId, not by name or position.
 * This means renames are detected correctly as a `name` field change rather
 * than an add+remove pair.
 */
export class ProjectDiffer {
  diff(base: CanonicalProject, head: CanonicalProject): CanonicalDiff {
    const baseMap = new Map<StableEntityId, CanonicalTarget>();
    for (const t of base.targets) baseMap.set(t.stableId, t);

    const headMap = new Map<StableEntityId, CanonicalTarget>();
    for (const t of head.targets) headMap.set(t.stableId, t);

    const added: CanonicalTarget[] = [];
    const removed: StableEntityId[] = [];
    const modified: TargetDiff[] = [];

    // Find added targets (in head but not in base)
    for (const [id, target] of headMap) {
      if (!baseMap.has(id)) {
        added.push(target);
      }
    }

    // Find removed targets (in base but not in head)
    for (const [id] of baseMap) {
      if (!headMap.has(id)) {
        removed.push(id);
      }
    }

    // Find modified targets (in both — compare fields)
    for (const [id, baseTarget] of baseMap) {
      const headTarget = headMap.get(id);
      if (!headTarget) continue;

      const targetDiff = this.diffTarget(baseTarget, headTarget);
      if (targetDiff !== null) {
        modified.push(targetDiff);
      }
    }

    return { added, removed, modified };
  }

  private diffTarget(base: CanonicalTarget, head: CanonicalTarget): TargetDiff | null {
    const diff: TargetDiff = { stableId: base.stableId };
    let hasChanges = false;

    // Name change
    if (base.name !== head.name) {
      diff.name = { from: base.name, to: head.name };
      hasChanges = true;
    }

    // Position change (sprites only)
    if (!base.isStage) {
      const bx = base.x ?? 0, by = base.y ?? 0;
      const hx = head.x ?? 0, hy = head.y ?? 0;
      if (bx !== hx || by !== hy) {
        diff.position = { from: { x: bx, y: by }, to: { x: hx, y: hy } };
        hasChanges = true;
      }
    }

    // Blocks diff
    const blocksDiff = this.diffBlocks(base.blocks, head.blocks);
    if (blocksDiff !== null) {
      diff.blocks = blocksDiff;
      hasChanges = true;
    }

    // Variables diff
    const varsDiff = this.diffVariables(base.variables, head.variables);
    if (varsDiff !== null) {
      diff.variables = varsDiff;
      hasChanges = true;
    }

    return hasChanges ? diff : null;
  }

  private diffBlocks(
    base: Record<string, CanonicalBlock>,
    head: Record<string, CanonicalBlock>,
  ): BlocksDiff | null {
    const added: Record<string, CanonicalBlock> = {};
    const removed: string[] = [];
    const modified: Record<string, { from: CanonicalBlock; to: CanonicalBlock }> = {};

    for (const [id, block] of Object.entries(head)) {
      if (!base[id]) {
        added[id] = block;
      }
    }

    for (const [id, block] of Object.entries(base)) {
      if (!head[id]) {
        removed.push(id);
      } else if (!this.blocksEqual(block, head[id])) {
        modified[id] = { from: block, to: head[id] };
      }
    }

    const hasChanges =
      Object.keys(added).length > 0 ||
      removed.length > 0 ||
      Object.keys(modified).length > 0;

    return hasChanges ? { added, removed, modified } : null;
  }

  private blocksEqual(a: CanonicalBlock, b: CanonicalBlock): boolean {
    // Deep equality via JSON — acceptable for MVP; optimize later if needed
    return JSON.stringify(a) === JSON.stringify(b);
  }

  private diffVariables(
    base: Record<string, any>,
    head: Record<string, any>,
  ): VariablesDiff | null {
    const added: Record<string, CanonicalVariable> = {};
    const removed: string[] = [];
    const modified: Record<string, { from: CanonicalVariable; to: CanonicalVariable }> = {};

    for (const [id, val] of Object.entries(head)) {
      if (!base[id]) {
        added[id] = val as CanonicalVariable;
      }
    }

    for (const [id, val] of Object.entries(base)) {
      if (!head[id]) {
        removed.push(id);
      } else if (JSON.stringify(val) !== JSON.stringify(head[id])) {
        modified[id] = { from: val as CanonicalVariable, to: head[id] as CanonicalVariable };
      }
    }

    const hasChanges =
      Object.keys(added).length > 0 ||
      removed.length > 0 ||
      Object.keys(modified).length > 0;

    return hasChanges ? { added, removed, modified } : null;
  }

  /**
   * Returns a human-readable summary of a diff — useful for logging and
   * eventually for generating PR descriptions.
   */
  summarize(diff: CanonicalDiff): string {
    const lines: string[] = [];

    if (diff.added.length > 0) {
      lines.push(`Added ${diff.added.length} target(s): ${diff.added.map((t) => t.name).join(", ")}`);
    }

    if (diff.removed.length > 0) {
      lines.push(`Removed ${diff.removed.length} target(s)`);
    }

    for (const td of diff.modified) {
      const parts: string[] = [];
      if (td.name) parts.push(`renamed "${td.name.from}" → "${td.name.to}"`);
      if (td.position) parts.push(`moved to (${td.position.to.x}, ${td.position.to.y})`);
      if (td.blocks) {
        const b = td.blocks;
        const bParts: string[] = [];
        if (Object.keys(b.added).length) bParts.push(`${Object.keys(b.added).length} block(s) added`);
        if (b.removed.length) bParts.push(`${b.removed.length} block(s) removed`);
        if (Object.keys(b.modified).length) bParts.push(`${Object.keys(b.modified).length} block(s) modified`);
        parts.push(`blocks: ${bParts.join(", ")}`);
      }
      if (td.variables) {
        const v = td.variables;
        const vParts: string[] = [];
        if (Object.keys(v.added).length) vParts.push(`${Object.keys(v.added).length} var(s) added`);
        if (v.removed.length) vParts.push(`${v.removed.length} var(s) removed`);
        if (Object.keys(v.modified).length) vParts.push(`${Object.keys(v.modified).length} var(s) modified`);
        parts.push(`variables: ${vParts.join(", ")}`);
      }
      lines.push(`Modified target ${td.stableId}: ${parts.join("; ")}`);
    }

    return lines.length > 0 ? lines.join("\n") : "No changes.";
  }
}
