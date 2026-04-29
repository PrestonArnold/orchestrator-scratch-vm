import { StableEntityId } from "./StableEntityId";

export type { StableEntityId };
export type ProjectJSON = any;

/**
 * VMOperation
 *
 * All operations use stableTargetId — a system-owned ID that survives VM
 * reloads. Never store VM-internal runtime IDs in these structs.
 *
 * Covers:
 *   Target-level:  MOVE, RENAME
 *   Variable-level: ADD_VARIABLE, SET_VARIABLE, REMOVE_VARIABLE
 *   Block-level:    ADD_BLOCK, UPDATE_BLOCK_FIELD, REMOVE_BLOCK
 */
export type VMOperation =
  // ─── Target ──────────────────────────────────────────────────────────────
  | {
      type: "TARGET_MOVE";
      stableTargetId: StableEntityId;
      x?: number;
      y?: number;
    }
  | {
      type: "TARGET_RENAME";
      stableTargetId: StableEntityId;
      name: string;
    }

  // ─── Variables ───────────────────────────────────────────────────────────
  | {
      type: "ADD_VARIABLE";
      stableTargetId: StableEntityId;
      /** Scratch variable UID — stable, system-assigned before calling this */
      variableId: string;
      name: string;
      value?: string | number | boolean;
      cloud?: boolean;
    }
  | {
      type: "SET_VARIABLE";
      stableTargetId: StableEntityId;
      variableId: string;
      value: string | number | boolean;
    }
  | {
      type: "REMOVE_VARIABLE";
      stableTargetId: StableEntityId;
      variableId: string;
    }

  // ─── Blocks ───────────────────────────────────────────────────────────────
  | {
      type: "ADD_BLOCK";
      stableTargetId: StableEntityId;
      blockId: string;
      block: RawBlock;
    }
  | {
      type: "UPDATE_BLOCK_FIELD";
      stableTargetId: StableEntityId;
      blockId: string;
      field: string;
      value: any;
    }
  | {
      type: "REMOVE_BLOCK";
      stableTargetId: StableEntityId;
      blockId: string;
    };

/**
 * Raw block shape — mirrors Scratch's project.json block object.
 * Passed directly into ADD_BLOCK and stored in the canonical model.
 */
export interface RawBlock {
  opcode: string;
  next: string | null;
  parent: string | null;
  inputs: Record<string, any>;
  fields: Record<string, any>;
  shadow: boolean;
  topLevel: boolean;
  x?: number;
  y?: number;
  mutation?: Record<string, any>;
  comment?: string;
}

// ─── Scratch VM runtime interfaces ───────────────────────────────────────────

/**
 * Runtime Variable instance shape (scratch-vm's Variable class).
 *
 * The project JSON format uses [name, value] arrays, but the *live* runtime
 * stores proper Variable objects with named properties. toJSON() converts
 * them back to arrays — we must never bypass this by writing arrays directly
 * into target.variables.
 */
export interface ScratchVariable {
  id: string;
  name: string;
  value: string | number | boolean;
  type: string; // '' = scalar, 'list', 'broadcast_msg'
  isCloud: boolean;
}

export interface ScratchTarget {
  id: string;
  x: number;
  y: number;
  isStage?: boolean;

  sprite: {
    name: string;
  };

  /**
   * Maps variable ID → runtime Variable instance.
   * Use target.createVariable() to add new entries — never assign raw arrays
   * here; toJSON() reads .name/.value off the Variable class, not indices.
   */
  variables: Record<string, ScratchVariable>;
  lists: Record<string, any>;

  /**
   * Constructs a proper Variable instance and registers it on this target.
   * type: '' = scalar (default), 'list', 'broadcast_msg'
   */
  createVariable(id: string, name: string, type: string, isCloud: boolean): void;

  blocks: {
    getBlock(id: string): ScratchBlock | undefined;
    createBlock(block: Record<string, any>): void;
    deleteBlock(id: string): void;
  };
}

export interface ScratchBlock {
  id: string;
  opcode: string;
  fields?: Record<string, any>;
}

export interface ScratchVMRuntime {
  loadProject(project: any): Promise<void> | void;
  clear?: () => Promise<void>;

  runtime: {
    targets: ScratchTarget[];
    getTargetById(id: string): ScratchTarget | undefined;
  };

  /**
   * Returns a JSON string (not an object).
   * Always use VMController.serialize() which parses this for you.
   */
  toJSON(): string | any;
}
