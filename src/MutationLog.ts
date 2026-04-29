import { VMOperation } from "./types";

export class MutationLog {
  private log: VMOperation[] = [];

  record(op: VMOperation) {
    this.log.push(structuredClone(op));
  }

  getAll() {
    return [...this.log];
  }

  clear() {
    this.log = [];
  }
}
