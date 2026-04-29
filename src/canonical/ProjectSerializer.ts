import { EntityRegistry } from "../EntityRegistry";
import { mintStableEntityId, STAGE_STABLE_ID, StableEntityId } from "../StableEntityId";
import {
  CanonicalBlock,
  CanonicalComment,
  CanonicalCostume,
  CanonicalMeta,
  CanonicalMonitor,
  CanonicalProject,
  CanonicalSound,
  CanonicalTarget,
} from "./types";

/**
 * ProjectSerializer
 *
 * Converts a raw Scratch VM project JSON (from vm.toJSON()) into a
 * CanonicalProject — our stable, VM-independent representation.
 *
 * The key job here is injecting StableEntityIds onto targets, using the
 * EntityRegistry to map target names → stable IDs. This is a read-only
 * operation — the registry is not mutated.
 *
 * Note: vm.toJSON() does NOT include runtime target IDs (id is purely a
 * runtime property). Targets are identified by name in the JSON, which is
 * the same anchor we use in EntityRegistry.
 */
export class ProjectSerializer {
  constructor(private registry: EntityRegistry) {}

  serialize(vmJson: any): CanonicalProject {
    const targets: CanonicalTarget[] = (vmJson.targets ?? []).map((t: any) =>
      this.serializeTarget(t),
    );

    const monitors: CanonicalMonitor[] = (vmJson.monitors ?? []).map(
      (m: any) => this.serializeMonitor(m),
    );

    const meta: CanonicalMeta = {
      semver: vmJson.meta?.semver ?? "3.0.0",
      vm: vmJson.meta?.vm ?? "",
      agent: vmJson.meta?.agent ?? "",
      ...(vmJson.meta?.platform ? { platform: vmJson.meta.platform } : {}),
    };

    return {
      targets,
      monitors,
      extensions: vmJson.extensions ?? [],
      meta,
    };
  }

  private serializeTarget(raw: any): CanonicalTarget {
    // Resolve stableId: stage gets the well-known constant, sprites get
    // looked up by name (or minted if not yet in registry).
    const stableId: StableEntityId = raw.isStage
      ? STAGE_STABLE_ID
      : this.resolveOrMintByName(raw.name);

    const base: CanonicalTarget = {
      stableId,
      isStage: raw.isStage ?? false,
      name: raw.name,

      variables: raw.variables ?? {},
      lists: raw.lists ?? {},
      broadcasts: raw.broadcasts ?? {},
      blocks: this.serializeBlocks(raw.blocks ?? {}),
      comments: this.serializeComments(raw.comments ?? {}),

      currentCostume: raw.currentCostume ?? 0,
      costumes: (raw.costumes ?? []).map((c: any) => this.serializeCostume(c)),
      sounds: (raw.sounds ?? []).map((s: any) => this.serializeSound(s)),
      volume: raw.volume ?? 100,
      layerOrder: raw.layerOrder ?? 0,
    };

    if (raw.isStage) {
      base.tempo = raw.tempo;
      base.videoTransparency = raw.videoTransparency;
      base.videoState = raw.videoState;
      base.textToSpeechLanguage = raw.textToSpeechLanguage ?? null;
    } else {
      base.visible = raw.visible ?? true;
      base.x = raw.x ?? 0;
      base.y = raw.y ?? 0;
      base.size = raw.size ?? 100;
      base.direction = raw.direction ?? 90;
      base.draggable = raw.draggable ?? false;
      base.rotationStyle = raw.rotationStyle ?? "all around";
    }

    return base;
  }

  private serializeBlocks(raw: Record<string, any>): Record<string, CanonicalBlock> {
    const result: Record<string, CanonicalBlock> = {};

    for (const [id, block] of Object.entries(raw)) {
      // Primitive blocks are stored as arrays inline inside inputs.
      // They appear as values in blocks map only as references — skip arrays.
      if (Array.isArray(block)) continue;

      const cb: CanonicalBlock = {
        opcode: block.opcode,
        next: block.next ?? null,
        parent: block.parent ?? null,
        inputs: block.inputs ?? {},
        fields: block.fields ?? {},
        shadow: block.shadow ?? false,
        topLevel: block.topLevel ?? false,
      };

      if (block.topLevel) {
        cb.x = block.x;
        cb.y = block.y;
      }

      if (block.mutation !== undefined) cb.mutation = block.mutation;
      if (block.comment !== undefined) cb.comment = block.comment;

      result[id] = cb;
    }

    return result;
  }

  private serializeComments(raw: Record<string, any>): Record<string, CanonicalComment> {
    const result: Record<string, CanonicalComment> = {};

    for (const [id, c] of Object.entries(raw)) {
      result[id] = {
        blockId: c.blockId ?? null,
        x: c.x ?? 0,
        y: c.y ?? 0,
        width: c.width ?? 200,
        height: c.height ?? 100,
        minimized: c.minimized ?? false,
        text: c.text ?? "",
      };
    }

    return result;
  }

  private serializeCostume(raw: any): CanonicalCostume {
    const c: CanonicalCostume = {
      name: raw.name,
      assetId: raw.assetId,
      dataFormat: raw.dataFormat,
      md5ext: raw.md5ext,
      rotationCenterX: raw.rotationCenterX ?? 0,
      rotationCenterY: raw.rotationCenterY ?? 0,
    };

    if (raw.bitmapResolution !== undefined) c.bitmapResolution = raw.bitmapResolution;

    return c;
  }

  private serializeSound(raw: any): CanonicalSound {
    const s: CanonicalSound = {
      name: raw.name,
      assetId: raw.assetId,
      dataFormat: raw.dataFormat,
      md5ext: raw.md5ext,
    };

    if (raw.format !== undefined) s.format = raw.format;
    if (raw.rate !== undefined) s.rate = raw.rate;
    if (raw.sampleCount !== undefined) s.sampleCount = raw.sampleCount;

    return s;
  }

  private serializeMonitor(raw: any): CanonicalMonitor {
    const m: CanonicalMonitor = {
      id: raw.id,
      mode: raw.mode ?? "default",
      opcode: raw.opcode,
      params: raw.params ?? {},
      spriteName: raw.spriteName ?? null,
      value: raw.value ?? 0,
      width: raw.width ?? 0,
      height: raw.height ?? 0,
      x: raw.x ?? 5,
      y: raw.y ?? 5,
      visible: raw.visible ?? true,
    };

    if (raw.sliderMin !== undefined) m.sliderMin = raw.sliderMin;
    if (raw.sliderMax !== undefined) m.sliderMax = raw.sliderMax;
    if (raw.isDiscrete !== undefined) m.isDiscrete = raw.isDiscrete;

    return m;
  }

  /**
   * Resolve a sprite name to its stable ID via the registry.
   * If the registry doesn't know the name (e.g. serializing a project that
   * was never loaded through VMController), mint a new ID on the fly.
   *
   * This ensures ProjectSerializer is usable standalone (e.g. for diffing
   * two project JSONs without a live VM).
   */
  private resolveOrMintByName(name: string): StableEntityId {
    // Walk the registry's nameToStable for a match.
    // We access this via listEntities — check if any entity has this name.
    // Since we can't directly reach nameToStable (private), we use a
    // secondary lookup approach: try to infer from a serialization-time name
    // map that we maintain locally if the registry can't help.
    //
    // The cleanest solution: add a resolveByName method to EntityRegistry.
    // That's done in EntityRegistry.resolveStableIdByName().
    const stableId = this.registry.resolveStableIdByName(name);
    if (stableId !== undefined) return stableId;

    // Not in registry — mint a fresh one. This happens when serializing a
    // project that was loaded outside this controller (e.g. standalone diff).
    return mintStableEntityId();
  }
}
