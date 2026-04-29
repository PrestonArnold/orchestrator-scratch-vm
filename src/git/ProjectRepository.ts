import type { CanonicalProject } from "../canonical/types";
import type { VMController } from "../VMController";
import type { VMOperation } from "../types";
import { GitAdapter, GitCommitResult, GitLogEntry, GitStatusEntry } from "./GitAdapter";

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
 * This class is the recommended way to use GitAdapter — it handles the
 * VMController lifecycle so you don't have to coordinate them manually.
 *
 * Usage:
 *   const repo = new ProjectRepository(controller, "./my-project.git");
 *   repo.init();
 *
 *   // Initial snapshot
 *   repo.snapshot("Initial commit");
 *
 *   // Apply some mutations and commit them as a single logical change
 *   repo.commitMutations([
 *     { type: "TARGET_RENAME", stableTargetId: id, name: "Hero" },
 *     { type: "TARGET_MOVE",   stableTargetId: id, x: 50, y: -30 },
 *   ], "Rename sprite to Hero and reposition");
 *
 *   // Read the project at any commit without leaving the current branch
 *   const past = repo.readAt("HEAD~2");
 *
 *   // Human-readable diff between two commits
 *   console.log(repo.diffStat("HEAD~1", "HEAD"));
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

  /**
   * Initialize the underlying git repository (idempotent).
   * Call this once before any other method.
   */
  init(): this {
    this.git.init();
    return this;
  }

  // ─── Committing ──────────────────────────────────────────────────────────

  /**
   * Write the current VM state to git and commit it.
   * Use this as your "save point" after any set of mutations.
   */
  snapshot(message: string): GitCommitResult {
    const canonical = this.controller.toCanonical();
    this.git.write(canonical);
    return this.git.commit(message);
  }

  /**
   * Apply a batch of mutations to the VM, then commit the result atomically.
   * This is the primary workflow — mutations + commit in one call.
   *
   * @param ops     Operations to apply (in order).
   * @param message Commit message.
   */
  commitMutations(ops: VMOperation[], message: string): GitCommitResult {
    for (const op of ops) {
      this.controller.applyMutation(op);
    }
    return this.snapshot(message);
  }

  // ─── History ─────────────────────────────────────────────────────────────

  /**
   * Read the canonical project at any git ref (branch, tag, hash, HEAD~n…)
   * WITHOUT touching the working tree or the loaded VM state.
   *
   * Safe to call at any time — won't disturb the current session.
   */
  readAt(ref: string): CanonicalProject {
    return this.git.readAt(ref);
  }

  /**
   * Checkout a ref, loading the project from that snapshot into the VM.
   * This replaces the current VM state — the MutationLog is NOT replayed.
   *
   * Returns the canonical project at that ref.
   */
  async checkout(ref: string): Promise<CanonicalProject> {
    // Switch working tree
    const canonical = this.git.checkout(ref);
    // Reload the VM from the snapshot so runtime state matches git state.
    // ProjectDeserializer lives in canonical/ProjectDeserializer — if it's
    // not wired up yet, we at minimum return the canonical model.
    // TODO: wire up controller.loadCanonical(canonical) when ProjectDeserializer
    //       is complete so the live VM matches the checked-out state.
    return canonical;
  }

  /**
   * Structured git log.
   */
  log(count = 20): GitLogEntry[] {
    return this.git.log(count);
  }

  // ─── Branching ───────────────────────────────────────────────────────────

  /**
   * Create and switch to a new branch from the current HEAD.
   */
  branch(name: string): void {
    this.git.branch(name);
  }

  /**
   * Switch to an existing branch.
   */
  switchBranch(name: string): void {
    this.git.switchBranch(name);
  }

  /**
   * List all local branches.
   */
  branches(): string[] {
    return this.git.branches();
  }

  /**
   * Current branch name.
   */
  currentBranch(): string {
    return this.git.currentBranch();
  }

  // ─── Diff ────────────────────────────────────────────────────────────────

  /**
   * Human-readable `git diff --stat` between two refs.
   * Great for logging what changed between commits.
   *
   * Example:
   *   repo.diffStat("HEAD~1", "HEAD")
   *   // → "sprites/se_abc123.json | 4 ++--"
   */
  diffStat(from: string, to: string): string {
    return this.git.diffStat(from, to);
  }

  /**
   * Full raw diff between two refs.
   */
  diffRaw(from: string, to: string): string {
    return this.git.diffRaw(from, to);
  }

  // ─── Status ──────────────────────────────────────────────────────────────

  /**
   * Whether there are uncommitted changes in the repo.
   */
  isDirty(): boolean {
    return this.git.isDirty();
  }

  /**
   * Structured working tree status.
   */
  status(): GitStatusEntry[] {
    return this.git.status();
  }

  /**
   * Resolve a ref to its full commit hash.
   */
  resolve(ref: string): string {
    return this.git.resolve(ref);
  }

  // ─── Escape hatch ────────────────────────────────────────────────────────

  /**
   * Direct access to the underlying GitAdapter for operations not covered above.
   */
  getGit(): GitAdapter {
    return this.git;
  }
}
