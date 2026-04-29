export type ProjectJSON = any;

// this is very simple.
// it's just to start.
export type VMOperation =
  | {
      type: "BLOCK_SET_VALUE";
      targetId: string;
      blockId: string;
      field: string;
      value: any;
    }
  | {
      type: "TARGET_MOVE";
      targetId: string;
      x?: number;
      y?: number;
    }
  | {
      type: "TARGET_RENAME";
      targetId: string;
      name: string;
    };

// scratch types
export interface ScratchTarget {
  id: string;
  x: number;
  y: number;

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
    getTargetById(id: string): ScratchTarget | undefined;
  };

  toJSON(): any;
}
