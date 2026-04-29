import type { CanonicalProject } from "../canonical/types";
import type { VMController } from "../VMController";
import { ProjectMerger, ProjectMergeResult, BlockConflict } from "../canonical/ProjectMerger";
import {
  ConflictResolver,
  IndexedConflict,
  Resolution,
  ResolutionMap,
  ResolvedMergeResult,
  conflictKey,
} from "../canonical/ConflictResolver";
import { GitAdapter, GitCommitResult } from "./GitAdapter";
import { ProjectRepository } from "./ProjectRepository";

// ─── MergeSession ─────────────────────────────────────────────────────────────

/**
 * MergeSession
 *
 * Orchestrates a full 3-way branch merge inside a ProjectRepository.
 *
 * Workflow:
 *
 *   1. Open a session:
 *        const session = repo.openMerge("feature-branch");
 *
 *   2. Inspect conflicts (if any):
 *        session.conflicts          // IndexedConflict[]
 *        session.isClean            // true if auto-merge succeeded
 *
 *   3. Resolve conflicts one at a time or all at once:
 *        session.resolve("aaa/input/STEPS", { pick: "ours" });
 *        session.resolveAll("theirs");  // bulk strategy
 *
 *   4. Commit the merge result:
 *        const commit = session.commit("Merge feature-branch into main");
 *        // This also loads the merged project into the VM controller.
 *
 *   5. Or abort if you don't like what you see:
 *        session.abort();
 *
 * The session keeps a mutable resolution state so UI can build up resolutions
 * incrementally (one conflict at a time) before committing.
 */
export class MergeSession {
  /** The common ancestor project (git merge-base). */
  readonly base: CanonicalProject;
  /** Our branch's tip project. */
  readonly ours: CanonicalProject;
  /** Their branch's tip project. */
  readonly theirs: CanonicalProject;

  /** The branch being merged in. */
  readonly theirBranch: string;
  /** The branch we are merging into (the branch that was current when opened). */
  readonly ourBranch: string;

  /** Indexed conflicts from the initial merge. */
  readonly conflicts: IndexedConflict[];

  /** true if the auto-merge had no conflicts. */
  get isClean(): boolean {
    return this.pendingConflicts.length === 0;
  }

  /** Conflicts still waiting for a resolution decision. */
  get pendingConflicts(): IndexedConflict[] {
    return this.conflicts.filter((c) => !this.resolutions.has(c.id));
  }

  /** Conflicts that have been given a resolution. */
  get resolvedConflicts(): IndexedConflict[] {
    return this.conflicts.filter((c) => this.resolutions.has(c.id));
  }

  private readonly initialMergeResult: ProjectMergeResult;
  private readonly resolutions: ResolutionMap = new Map();
  private readonly resolver = new ConflictResolver();
  private committed = false;

  constructor(
    private readonly repository: ProjectRepository,
    private readonly controller: VMController,
    opts: {
      base: CanonicalProject;
      ours: CanonicalProject;
      theirs: CanonicalProject;
      mergeResult: ProjectMergeResult;
      ourBranch: string;
      theirBranch: string;
    },
  ) {
    this.base       = opts.base;
    this.ours       = opts.ours;
    this.theirs     = opts.theirs;
    this.ourBranch  = opts.ourBranch;
    this.theirBranch = opts.theirBranch;
    this.initialMergeResult = opts.mergeResult;
    this.conflicts  = this.resolver.index(opts.mergeResult);
  }

  // ─── Resolution API ────────────────────────────────────────────────────────

  /**
   * Resolve a single conflict by its stable key.
   * Key format: "<blockId>/<aspect>/<key>" (from IndexedConflict.id).
   *
   *   session.resolve("aaa/input/STEPS", { pick: "ours" });
   *   session.resolve("bbb/opcode/opcode", { pick: "theirs" });
   *   session.resolve("ccc/field/X", { pick: "custom", value: ["42", null] });
   */
  resolve(conflictId: string, resolution: Resolution): this {
    this.assertNotCommitted();
    if (!this.conflicts.some((c) => c.id === conflictId)) {
      throw new Error(`No conflict with id "${conflictId}"`);
    }
    this.resolutions.set(conflictId, resolution);
    return this;
  }

  /**
   * Clear a previously-set resolution (go back to pending).
   */
  unresolve(conflictId: string): this {
    this.assertNotCommitted();
    this.resolutions.delete(conflictId);
    return this;
  }

  /**
   * Apply a bulk strategy to all remaining pending conflicts.
   *
   *   session.resolveAll("ours")   → accept ours for everything unresolved
   *   session.resolveAll("theirs") → accept theirs for everything unresolved
   *   session.resolveAll("base")   → revert all conflicts to base
   */
  resolveAll(strategy: "ours" | "theirs" | "base"): this {
    this.assertNotCommitted();
    for (const c of this.pendingConflicts) {
      this.resolutions.set(c.id, { pick: strategy });
    }
    return this;
  }

  // ─── Preview ───────────────────────────────────────────────────────────────

  /**
   * Preview the current merge result without committing.
   * Useful for showing the user what the project will look like.
   *
   * Returns null if there are still pending (unresolved) conflicts —
   * the result would be incomplete and shouldn't be previewed as final.
   */
  preview(): ResolvedMergeResult | null {
    if (this.pendingConflicts.length > 0) return null;
    return this.resolver.resolve(this.initialMergeResult, this.resolutions);
  }

  /**
   * Preview even if there are pending conflicts.
   * Pending conflicts will use the base value (safe fallback).
   */
  previewPartial(): ResolvedMergeResult {
    return this.resolver.resolve(this.initialMergeResult, this.resolutions);
  }

  // ─── Commit ────────────────────────────────────────────────────────────────

  /**
   * Finalize the merge:
   *   1. Apply all resolutions (pending conflicts fall back to base value)
   *   2. Write the result to git and commit on ourBranch
   *   3. Load the merged project into the VM controller
   *
   * Throws if the session was already committed or aborted.
   */
  async commit(message?: string): Promise<GitCommitResult> {
    this.assertNotCommitted();
    this.committed = true;

    const resolved = this.resolver.resolve(this.initialMergeResult, this.resolutions);
    const commitMessage = message ?? this.defaultCommitMessage();

    // Write the resolved project to disk and commit it
    const git = this.repository.getGit();
    git.write(resolved.project);
    const result = git.commit(commitMessage);

    // Load into the live VM
    await this.controller.loadCanonical(resolved.project);

    return result;
  }

  /**
   * Abort the merge session. Does not modify the repo or VM.
   * After abort, no other methods may be called.
   */
  abort(): void {
    this.assertNotCommitted();
    this.committed = true; // reuse flag to prevent further use
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private defaultCommitMessage(): string {
    const conflictCount = this.conflicts.length;
    if (conflictCount === 0) {
      return `Merge branch '${this.theirBranch}' into ${this.ourBranch}`;
    }
    const resolvedHere = this.resolvedConflicts.length;
    const autoResolved = conflictCount - resolvedHere;
    return [
      `Merge branch '${this.theirBranch}' into ${this.ourBranch}`,
      ``,
      `${conflictCount} conflict(s) during merge:`,
      autoResolved   > 0 ? `  ${autoResolved} auto-resolved (base value kept)` : null,
      resolvedHere   > 0 ? `  ${resolvedHere} manually resolved` : null,
    ]
      .filter((l) => l !== null)
      .join("\n");
  }

  private assertNotCommitted(): void {
    if (this.committed) {
      throw new Error("MergeSession has already been committed or aborted.");
    }
  }
}

// ─── openMerge factory (attached to ProjectRepository via module augmentation) ─

/**
 * Open a MergeSession for merging `theirBranch` into the current branch.
 *
 * This is a standalone function rather than a method on ProjectRepository to
 * avoid circular imports. Wire it in via the `openMerge` export below — callers
 * import it directly or use the re-exported version from git/index.ts.
 *
 * What it does:
 *   1. Find the merge-base commit (common ancestor)
 *   2. Read base, ours (HEAD), theirs (theirBranch tip) as CanonicalProjects
 *   3. Run ProjectMerger.merge(base, ours, theirs)
 *   4. Return a MergeSession ready for conflict resolution
 */
export function openMerge(
  repository: ProjectRepository,
  controller: VMController,
  theirBranch: string,
): MergeSession {
  const git = repository.getGit();

  const ourBranch  = repository.currentBranch();
  const ourRef     = "HEAD";
  const theirRef   = theirBranch;

  // Find common ancestor
  const mergeBase = findMergeBase(git, ourRef, theirRef);

  const base   = repository.readAt(mergeBase);
  const ours   = repository.readAt(ourRef);
  const theirs = repository.readAt(theirRef);

  const merger = new ProjectMerger();
  const mergeResult = merger.merge(base, ours, theirs);

  return new MergeSession(repository, controller, {
    base,
    ours,
    theirs,
    mergeResult,
    ourBranch,
    theirBranch,
  });
}

/**
 * Find the common ancestor of two refs.
 * Uses `git merge-base` — available in all modern git versions.
 */
function findMergeBase(git: GitAdapter, ref1: string, ref2: string): string {
  // GitAdapter doesn't expose arbitrary commands, so we need to reach through
  // to the underlying execSync. We do this via the resolve() workaround:
  // `git merge-base A B` gives us the base hash.
  //
  // Since GitAdapter.resolve() only handles rev-parse, we call it via the
  // private git() method indirectly. The cleanest approach is to add a
  // mergeBase() method to GitAdapter — which we do via the augmented export.
  return (git as any)._mergeBase(ref1, ref2);
}
