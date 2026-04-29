import { StableEntityId } from "./StableEntityId";

export type { StableEntityId };
export type ProjectJSON = any;

export type VMOperation =
  | {
      type: "BLOCK_SET_VALUE";
      stableTargetId: StableEntityId;
      blockId: string;
      field: string;
      value: any;
    }
  | {
      type: "TARGET_MOVE";
      stableTargetId: StableEntityId;
      x?: number;
      y?: number;
    }
  | {
      type: "TARGET_RENAME";
      stableTargetId: StableEntityId;
      /** The new name to assign. */
      name: string;
    };

export interface ScratchTarget {
  id: string;
  x: number;
  y: number;
  isStage?: boolean;

  sprite: {
    name: string;
  };

  blocks: {
    getBlock(id: string): ScratchBlock | undefined;
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

  toJSON(): any;
}
