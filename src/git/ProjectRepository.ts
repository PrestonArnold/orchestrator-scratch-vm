import type { CanonicalProject } from "../canonical/types";
import type { VMController } from "../VMController";
import type { VMOperation } from "../types";
import { GitAdapter, GitCommitResult, GitLogEntry, GitStatusEntry } from "./GitAdapter";
import { MergeSession, openMerge } from "./MergeSession";

// ─── ProjectRepository ────────────────────────────────────────────────────────

/**
 * ProjectRepository
 *
 * The integration point between the vm-orchestration system and real Git.
 *
 * Maps the event-sourced concepts cleanly onto git:
 *
 *   | Your concept       | Git concept                          |
 *   | ─────────────────  | ──────────────────────────────────── |
 *   | MutationLog batch  | commit                               |
 *   | CanonicalProject   | tree (set of tracked files)          |
 *   | ReplayEngine       | git checkout                         |
 *   | CanonicalDiff      | git diff                             |
 *   | branch             | branch                               |
 *
 * Usage:
 *   const repo = new ProjectRepository(controller, "./my-project.git");
 *   repo.init();
 *
 *   // Initial snapshot
 *   repo.snapshot("Initial commit");
 *
 *   // Apply some mutations and commit them
 *   repo.commitMutations([
 *     { type: "TARGET_RENAME", stableTargetId: id, name: "Hero" },
 *   ], "Rename sprite to Hero");
 *
 *   // 3-way merge from a feature branch
 *   const session = repo.openMerge("feature-branch");
 *   if (!session.isClean) {
 *     session.resolve("aaa/input/STEPS", { pick: "ours" });
 *   }
 *   await session.commit();
 */
export class ProjectRepository {
  private readonly git: GitAdapter;

  constructor(
    private readonly controller: VMController,
    repoPath: string,
  ) {
    this.git = new GitAdapter(repoPath);
  }

  // ─── Setup ───────────────────────────────────────────────────────────────

  init(): this {
    this.git.init();
    return this;
  }

  // ─── Committing ──────────────────────────────────────────────────────────

  snapshot(message: string): GitCommitResult {
    const canonical = this.controller.toCanonical();
    this.git.write(canonical);
    return this.git.commit(message);
  }

  commitMutations(ops: VMOperation[], message: string): GitCommitResult {
    for (const op of ops) {
      this.controller.applyMutation(op);
    }
    return this.snapshot(message);
  }

  // ─── History ─────────────────────────────────────────────────────────────

  readAt(ref: string): CanonicalProject {
    return this.git.readAt(ref);
  }

  async checkout(ref: string): Promise<CanonicalProject> {
    const canonical = this.git.checkout(ref);
    await this.controller.loadCanonical(canonical);
    return canonical;
  }

  log(count = 20): GitLogEntry[] {
    return this.git.log(count);
  }

  // ─── Branching ───────────────────────────────────────────────────────────

  branch(name: string): void {
    this.git.branch(name);
  }

  switchBranch(name: string): void {
    this.git.switchBranch(name);
  }

  branches(): string[] {
    return this.git.branches();
  }

  currentBranch(): string {
    return this.git.currentBranch();
  }

  // ─── Merge ───────────────────────────────────────────────────────────────

  /**
   * Open a 3-way MergeSession to merge `theirBranch` into the current branch.
   *
   * The session:
   *   1. Finds the merge-base (common ancestor)
   *   2. Runs ProjectMerger.merge(base, ours, theirs)
   *   3. Returns a MergeSession with indexed conflicts ready for resolution
   *
   * Usage:
   *   const session = repo.openMerge("feature-branch");
   *
   *   if (!session.isClean) {
   *     // Inspect what's conflicting
   *     session.conflicts.forEach(c =>
   *       console.log(c.id, c.aspect, c.ours, c.theirs)
   *     );
   *
   *     // Resolve one at a time
   *     session.resolve("blockId/input/STEPS", { pick: "ours" });
   *
   *     // Or resolve all remaining with a bulk strategy
   *     session.resolveAll("theirs");
   *   }
   *
   *   // Commit the merge (loads merged project into the VM)
   *   await session.commit("Merge feature-branch into main");
   */
  openMerge(theirBranch: string): MergeSession {
    return openMerge(this, this.controller, theirBranch);
  }

  // ─── Diff ────────────────────────────────────────────────────────────────

  diffStat(from: string, to: string): string {
    return this.git.diffStat(from, to);
  }

  diffRaw(from: string, to: string): string {
    return this.git.diffRaw(from, to);
  }

  // ─── Status ──────────────────────────────────────────────────────────────

  isDirty(): boolean {
    return this.git.isDirty();
  }

  status(): GitStatusEntry[] {
    return this.git.status();
  }

  resolve(ref: string): string {
    return this.git.resolve(ref);
  }

  // ─── Escape hatch ────────────────────────────────────────────────────────

  getGit(): GitAdapter {
    return this.git;
  }
}
