import { StableEntityId } from "../StableEntityId";

/**
 * CanonicalProject
 *
 * A VM-independent representation of a Scratch 3 project.
 *
 * This is the system's source of truth. The VM is derived from it — not the
 * other way around. All diffs, PRs, branches, and collaboration messages
 * operate on this type.
 *
 * Design rules:
 *   - Target identities use StableEntityId (ours), not VM runtime IDs
 *   - Variable, list, block, and broadcast IDs are kept as-is from Scratch
 *     (they're already stable within a project file)
 *   - The shape mirrors Scratch's project.json closely so serialization is
 *     a thin pass-through rather than a deep transform
 *   - No VM-internal fields (e.g. no runtime `id` on targets)
 */

// ─── Project ──────────────────────────────────────────────────────────────────

export interface CanonicalProject {
  targets: CanonicalTarget[];
  monitors: CanonicalMonitor[];
  extensions: string[];
  meta: CanonicalMeta;
}

export interface CanonicalMeta {
  semver: string;
  vm: string;
  agent: string;
  platform?: { name: string; url: string };
}

// ─── Targets ──────────────────────────────────────────────────────────────────

/**
 * CanonicalTarget covers both the stage and sprites.
 * Use `isStage` to discriminate.
 */
export interface CanonicalTarget {
  /** Our stable, system-owned ID. Never a VM runtime ID. */
  stableId: StableEntityId;

  isStage: boolean;
  name: string;

  variables: Record<string, CanonicalVariable>;
  lists: Record<string, CanonicalList>;
  broadcasts: Record<string, string>; // { [uid]: name }
  blocks: Record<string, CanonicalBlock>;
  comments: Record<string, CanonicalComment>;

  currentCostume: number;
  costumes: CanonicalCostume[];
  sounds: CanonicalSound[];
  volume: number;
  layerOrder: number;

  // Stage-only (present when isStage = true)
  tempo?: number;
  videoTransparency?: number;
  videoState?: string;
  textToSpeechLanguage?: string | null;

  // Sprite-only (present when isStage = false)
  visible?: boolean;
  x?: number;
  y?: number;
  size?: number;
  direction?: number;
  draggable?: boolean;
  rotationStyle?: string;
}

// ─── Variables & Lists ────────────────────────────────────────────────────────

/** [name, currentValue] or [name, currentValue, true] for cloud vars */
export type CanonicalVariable = [string, string | number | boolean] | [string, string | number | boolean, true];

/** [name, items[]] */
export type CanonicalList = [string, Array<string | number | boolean>];

// ─── Blocks ───────────────────────────────────────────────────────────────────

/**
 * Block objects mirror Scratch's project.json block shape exactly.
 * Primitive blocks (numbers, strings, variable getters, etc.) are stored
 * inline as arrays inside `inputs` — we don't unwrap them.
 */
export interface CanonicalBlock {
  opcode: string;
  next: string | null;
  parent: string | null;
  inputs: Record<string, CanonicalBlockInput>;
  fields: Record<string, CanonicalBlockField>;
  shadow: boolean;
  topLevel: boolean;
  // Only present when topLevel = true
  x?: number;
  y?: number;
  // Optional
  mutation?: Record<string, any>;
  comment?: string;
}

/**
 * Block input value:
 *   [inputMode, blockOrPrimitive]
 *   [inputMode, blockOrPrimitive, shadowBlock]
 *
 * inputMode: 1=same_block_shadow, 2=no_shadow, 3=obscured_shadow
 * blockOrPrimitive: a block ID string, or an inline primitive array
 */
export type CanonicalBlockInput = [number, CanonicalBlockInputValue] | [number, CanonicalBlockInputValue, CanonicalBlockInputValue];
export type CanonicalBlockInputValue = string | CanonicalPrimitive | null;

/**
 * Primitive (compressed) block — stored inline inside inputs.
 * [type, value] or [type, value, id] or [type, value, id, x, y]
 *
 * Type codes:
 *   4=math_number  5=positive_number  6=whole_number  7=integer  8=angle
 *   9=colour  10=text  11=broadcast_menu  12=data_variable  13=data_listcontents
 */
export type CanonicalPrimitive =
  | [number, string | number]
  | [number, string | number, string]
  | [number, string | number, string, number, number];

/**
 * Block field: ["value"] or ["value", "variableId"]
 */
export type CanonicalBlockField = [string] | [string, string | null];

// ─── Costumes & Sounds ────────────────────────────────────────────────────────

export interface CanonicalCostume {
  name: string;
  assetId: string;
  dataFormat: string;
  md5ext: string;
  rotationCenterX: number;
  rotationCenterY: number;
  bitmapResolution?: number;
}

export interface CanonicalSound {
  name: string;
  assetId: string;
  dataFormat: string;
  md5ext: string;
  format?: string;
  rate?: number;
  sampleCount?: number;
}

// ─── Comments ─────────────────────────────────────────────────────────────────

export interface CanonicalComment {
  blockId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  text: string;
}

// ─── Monitors ─────────────────────────────────────────────────────────────────

export interface CanonicalMonitor {
  id: string;
  mode: "default" | "large" | "slider" | "list";
  opcode: string;
  params: Record<string, string>;
  spriteName: string | null;
  value: string | number | boolean | Array<any>;
  width: number;
  height: number;
  x: number;
  y: number;
  visible: boolean;
  // Scalar monitors only
  sliderMin?: number;
  sliderMax?: number;
  isDiscrete?: boolean;
}

// ─── Diff types ───────────────────────────────────────────────────────────────

export type CanonicalDiff = {
  added: CanonicalTarget[];
  removed: StableEntityId[];
  modified: TargetDiff[];
};

export type TargetDiff = {
  stableId: StableEntityId;
  name?: { from: string; to: string };
  position?: { from: { x: number; y: number }; to: { x: number; y: number } };
  blocks?: BlocksDiff;
  variables?: VariablesDiff;
};

export type BlocksDiff = {
  added: Record<string, CanonicalBlock>;
  removed: string[];
  modified: Record<string, { from: CanonicalBlock; to: CanonicalBlock }>;
};

export type VariablesDiff = {
  added: Record<string, CanonicalVariable>;
  removed: string[];
  modified: Record<string, { from: CanonicalVariable; to: CanonicalVariable }>;
};
