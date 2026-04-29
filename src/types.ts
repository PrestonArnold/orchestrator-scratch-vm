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
