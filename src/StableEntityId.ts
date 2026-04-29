import { randomUUID } from "crypto";

export type StableEntityId = string & { readonly __brand: "StableEntityId" };

export function mintStableEntityId(): StableEntityId {
  return `se_${randomUUID()}` as StableEntityId;
}

export const STAGE_STABLE_ID = "se_stage" as StableEntityId;
