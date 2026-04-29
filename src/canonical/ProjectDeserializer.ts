import { CanonicalProject, CanonicalTarget } from "./types";

/**
 * ProjectDeserializer
 *
 * Converts a CanonicalProject back into a plain Scratch project JSON that
 * scratch-vm can load via loadProject().
 *
 * The key job here is stripping `stableId` off targets — that field is
 * internal to our system and must never appear in files passed to the VM.
 *
 * Everything else passes through as-is; the canonical shape mirrors
 * Scratch's project.json closely by design.
 */
export class ProjectDeserializer {
  deserialize(project: CanonicalProject): any {
    return {
      targets: project.targets.map((t) => this.deserializeTarget(t)),
      monitors: project.monitors,
      extensions: project.extensions,
      meta: project.meta,
    };
  }

  private deserializeTarget(target: CanonicalTarget): any {
    // Destructure stableId out; everything else goes to the VM.
    const { stableId: _stableId, ...rest } = target;

    const out: any = {
      isStage: rest.isStage,
      name: rest.name,
      variables: rest.variables,
      lists: rest.lists,
      broadcasts: rest.broadcasts,
      blocks: rest.blocks,
      comments: rest.comments,
      currentCostume: rest.currentCostume,
      costumes: rest.costumes,
      sounds: rest.sounds,
      volume: rest.volume,
      layerOrder: rest.isStage ? rest.layerOrder : Math.max(1, rest.layerOrder ?? 1),
    };

    if (rest.isStage) {
      if (rest.tempo !== undefined) out.tempo = rest.tempo;
      if (rest.videoTransparency !== undefined) out.videoTransparency = rest.videoTransparency;
      if (rest.videoState !== undefined) out.videoState = rest.videoState;
      out.textToSpeechLanguage = rest.textToSpeechLanguage ?? null;
    } else {
      out.visible = rest.visible ?? true;
      out.x = rest.x ?? 0;
      out.y = rest.y ?? 0;
      out.size = rest.size ?? 100;
      out.direction = rest.direction ?? 90;
      out.draggable = rest.draggable ?? false;
      out.rotationStyle = rest.rotationStyle ?? "all around";
    }

    return out;
  }
}
