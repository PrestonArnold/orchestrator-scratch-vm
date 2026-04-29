import { StableEntityId } from "../StableEntityId";
import {
  CanonicalBlock,
  CanonicalBlockField,
  CanonicalBlockInput,
  CanonicalBlockInputValue,
  CanonicalDiff,
  CanonicalProject,
  CanonicalTarget,
  CanonicalVariable,
  TargetDiff,
  VariablesDiff,
} from "./types";

// ─── Block diff types ─────────────────────────────────────────────────────────

/**
 * A field-level change: the stored [value] or [value, id] tuple changed.
 */
export type FieldChange = {
  from: CanonicalBlockField;
  to: CanonicalBlockField;
};

/**
 * An input-level change.
 *
 * Inputs hold either:
 *   - a block ID reference (connection)
 *   - an inline primitive [type, value, ...]
 *
 * We distinguish these because they mean very different things semantically.
 */
export type InputChange =
  | { kind: "value_changed"; from: CanonicalBlockInputValue; to: CanonicalBlockInputValue }
  | { kind: "connection_changed"; from: string | null; to: string | null };

/**
 * All the ways a single block can change.
 * Every field is optional — only present when that aspect actually changed.
 */
export type BlockChange = {
  id: string;
  opcode?: { from: string; to: string };
  fields?: Record<string, FieldChange>;
  inputs?: Record<string, InputChange>;
  /** next/parent pointer changed — block moved in the graph */
  structure?: {
    next?: { from: string | null; to: string | null };
    parent?: { from: string | null; to: string | null };
  };
};

/**
 * Structural diff of a single target's block graph.
 * Keyed by block ID throughout — never by position.
 */
export type BlockGraphDiff = {
  added: string[];        // block IDs new in head
  removed: string[];      // block IDs gone from head
  modified: BlockChange[]; // blocks present in both but changed
};

// ─── BlockDiffer ─────────────────────────────────────────────────────────────

export class BlockDiffer {
  /**
   * Diff two flat block maps (Record<id, CanonicalBlock>).
   * Returns null if there are no changes.
   */
  diff(
    base: Record<string, CanonicalBlock>,
    head: Record<string, CanonicalBlock>,
  ): BlockGraphDiff | null {
    const added: string[] = [];
    const removed: string[] = [];
    const modified: BlockChange[] = [];

    // Added: in head but not base
    for (const id of Object.keys(head)) {
      if (!base[id]) added.push(id);
    }

    // Removed: in base but not head
    for (const id of Object.keys(base)) {
      if (!head[id]) removed.push(id);
    }

    // Modified: in both — compare structurally
    for (const id of Object.keys(base)) {
      if (!head[id]) continue;
      const change = this.diffBlock(id, base[id], head[id]);
      if (change !== null) modified.push(change);
    }

    if (added.length === 0 && removed.length === 0 && modified.length === 0) {
      return null;
    }

    return { added, removed, modified };
  }

  /**
   * Diff a single block. Returns null if nothing changed.
   * Ignores x/y (layout noise on top-level blocks).
   */
  private diffBlock(
    id: string,
    base: CanonicalBlock,
    head: CanonicalBlock,
  ): BlockChange | null {
    const change: BlockChange = { id };
    let hasChanges = false;

    // Opcode (should be rare — means block was replaced)
    if (base.opcode !== head.opcode) {
      change.opcode = { from: base.opcode, to: head.opcode };
      hasChanges = true;
    }

    // Fields
    const fieldChanges = this.diffFields(base.fields, head.fields);
    if (fieldChanges !== null) {
      change.fields = fieldChanges;
      hasChanges = true;
    }

    // Inputs
    const inputChanges = this.diffInputs(base.inputs, head.inputs);
    if (inputChanges !== null) {
      change.inputs = inputChanges;
      hasChanges = true;
    }

    // Structure (next/parent — graph topology)
    const structureChange = this.diffStructure(base, head);
    if (structureChange !== null) {
      change.structure = structureChange;
      hasChanges = true;
    }

    return hasChanges ? change : null;
  }

  private diffFields(
    base: Record<string, CanonicalBlockField>,
    head: Record<string, CanonicalBlockField>,
  ): Record<string, FieldChange> | null {
    const changes: Record<string, FieldChange> = {};
    const allKeys = new Set([...Object.keys(base), ...Object.keys(head)]);

    for (const key of allKeys) {
      const b = base[key];
      const h = head[key];
      if (JSON.stringify(b) !== JSON.stringify(h)) {
        changes[key] = { from: b, to: h };
      }
    }

    return Object.keys(changes).length > 0 ? changes : null;
  }

  private diffInputs(
    base: Record<string, CanonicalBlockInput>,
    head: Record<string, CanonicalBlockInput>,
  ): Record<string, InputChange> | null {
    const changes: Record<string, InputChange> = {};
    const allKeys = new Set([...Object.keys(base), ...Object.keys(head)]);

    for (const key of allKeys) {
      const b = base[key];
      const h = head[key];

      if (JSON.stringify(b) === JSON.stringify(h)) continue;

      const change = this.diffInput(b, h);
      if (change !== null) changes[key] = change;
    }

    return Object.keys(changes).length > 0 ? changes : null;
  }

  /**
   * Diff a single input slot.
   *
   * An input is [mode, valueOrId] or [mode, valueOrId, shadowId].
   * The "value" (index 1) is either:
   *   - a string block ID → this is a connection
   *   - a CanonicalPrimitive array → this is an inline value
   *   - null → empty input
   */
  private diffInput(
    base: CanonicalBlockInput | undefined,
    head: CanonicalBlockInput | undefined,
  ): InputChange | null {
    // Extract the primary value (index 1 of the input tuple)
    const bVal = base ? base[1] : null;
    const hVal = head ? head[1] : null;

    if (JSON.stringify(bVal) === JSON.stringify(hVal)) return null;

    // Is this a block-ID connection or an inline primitive?
    const bIsConnection = typeof bVal === "string";
    const hIsConnection = typeof hVal === "string";

    if (bIsConnection || hIsConnection) {
      // Connection changed: a block reference was added, removed, or rewired
      return {
        kind: "connection_changed",
        from: bIsConnection ? (bVal as string) : null,
        to: hIsConnection ? (hVal as string) : null,
      };
    }

    // Inline primitive value changed
    return {
      kind: "value_changed",
      from: bVal,
      to: hVal,
    };
  }

  private diffStructure(
    base: CanonicalBlock,
    head: CanonicalBlock,
  ): BlockChange["structure"] | null {
    const s: BlockChange["structure"] = {};
    let hasChanges = false;

    if (base.next !== head.next) {
      s.next = { from: base.next, to: head.next };
      hasChanges = true;
    }

    if (base.parent !== head.parent) {
      s.parent = { from: base.parent, to: head.parent };
      hasChanges = true;
    }

    return hasChanges ? s : null;
  }
}

// ─── ProjectDiffer ────────────────────────────────────────────────────────────

/**
 * ProjectDiffer
 *
 * Computes the structural diff between two CanonicalProjects.
 *
 * Block-level diffing uses BlockDiffer, which produces field/input/structure
 * granularity rather than opaque { from, to } blobs. This is the foundation
 * for merge, PR reviews, and conflict detection.
 */
export class ProjectDiffer {
  private readonly blockDiffer = new BlockDiffer();

  diff(base: CanonicalProject, head: CanonicalProject): CanonicalDiff {
    const baseMap = new Map<StableEntityId, CanonicalTarget>();
    for (const t of base.targets) baseMap.set(t.stableId, t);

    const headMap = new Map<StableEntityId, CanonicalTarget>();
    for (const t of head.targets) headMap.set(t.stableId, t);

    const added: CanonicalTarget[] = [];
    const removed: StableEntityId[] = [];
    const modified: TargetDiff[] = [];

    for (const [id, target] of headMap) {
      if (!baseMap.has(id)) added.push(target);
    }

    for (const [id] of baseMap) {
      if (!headMap.has(id)) removed.push(id);
    }

    for (const [id, baseTarget] of baseMap) {
      const headTarget = headMap.get(id);
      if (!headTarget) continue;
      const targetDiff = this.diffTarget(baseTarget, headTarget);
      if (targetDiff !== null) modified.push(targetDiff);
    }

    return { added, removed, modified };
  }

  private diffTarget(base: CanonicalTarget, head: CanonicalTarget): TargetDiff | null {
    const diff: TargetDiff = { stableId: base.stableId };
    let hasChanges = false;

    if (base.name !== head.name) {
      diff.name = { from: base.name, to: head.name };
      hasChanges = true;
    }

    if (!base.isStage) {
      const bx = base.x ?? 0, by = base.y ?? 0;
      const hx = head.x ?? 0, hy = head.y ?? 0;
      if (bx !== hx || by !== hy) {
        diff.position = { from: { x: bx, y: by }, to: { x: hx, y: hy } };
        hasChanges = true;
      }
    }

    const blocksDiff = this.blockDiffer.diff(base.blocks, head.blocks);
    if (blocksDiff !== null) {
      diff.blocks = blocksDiff;
      hasChanges = true;
    }

    const varsDiff = this.diffVariables(base.variables, head.variables);
    if (varsDiff !== null) {
      diff.variables = varsDiff;
      hasChanges = true;
    }

    return hasChanges ? diff : null;
  }

  private diffVariables(
    base: Record<string, any>,
    head: Record<string, any>,
  ): VariablesDiff | null {
    const added: Record<string, CanonicalVariable> = {};
    const removed: string[] = [];
    const modified: Record<string, { from: CanonicalVariable; to: CanonicalVariable }> = {};

    for (const [id, val] of Object.entries(head)) {
      if (!base[id]) added[id] = val;
    }

    for (const [id, val] of Object.entries(base)) {
      if (!head[id]) {
        removed.push(id);
      } else if (JSON.stringify(val) !== JSON.stringify(head[id])) {
        modified[id] = { from: val, to: head[id] };
      }
    }

    const hasChanges =
      Object.keys(added).length > 0 ||
      removed.length > 0 ||
      Object.keys(modified).length > 0;

    return hasChanges ? { added, removed, modified } : null;
  }

  /**
   * Human-readable summary. Now uses the richer block diff.
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
        const b = td.blocks as BlockGraphDiff;
        const bParts: string[] = [];
        if (b.added.length) bParts.push(`${b.added.length} block(s) added`);
        if (b.removed.length) bParts.push(`${b.removed.length} block(s) removed`);
        if (b.modified.length) {
          const fieldChanges = b.modified.filter((c) => c.fields).length;
          const inputChanges = b.modified.filter((c) => c.inputs).length;
          const structureChanges = b.modified.filter((c) => c.structure).length;
          const mParts: string[] = [];
          if (fieldChanges) mParts.push(`${fieldChanges} field change(s)`);
          if (inputChanges) mParts.push(`${inputChanges} input change(s)`);
          if (structureChanges) mParts.push(`${structureChanges} structural change(s)`);
          bParts.push(`${b.modified.length} block(s) modified (${mParts.join(", ")})`);
        }
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
