import { VMOperation } from "./types";
import { VMController } from "./VMController";

export class ReplayEngine {
  constructor(private controller: VMController) {}

  async replay(log: VMOperation[], base?: any): Promise<any> {
    if (base !== undefined) {
      await this.controller.load(base);
    } else {
      // Re-load the controller's current project to get a clean VM state.
      const project = this.controller.getProject();
      await this.controller.load(project);
    }

    for (const op of log) {
      this.controller.applyMutation(op);
    }

    return this.controller.serialize();
  }
}
