import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CanonicalProject, CanonicalTarget } from "../canonical/types";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GitCommitResult {
  hash: string;
  shortHash: string;
  message: string;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

export interface GitStatusEntry {
  status: string; // M, A, D, ?, etc.
  path: string;
}

// ─── GitAdapter ───────────────────────────────────────────────────────────────

/**
 * GitAdapter
 *
 * A thin wrapper over the real `git` binary.
 * All git knowledge lives here — no git lib, no reimplementation.
 *
 * Responsibilities:
 *   - Own the on-disk file layout of a canonical project in a git repo
 *   - Translate between CanonicalProject ↔ repo files
 *   - Expose git verbs (commit, checkout, branch, log, diff) as typed methods
 *
 * File layout:
 *   <repoPath>/
 *     meta.json           ← monitors, extensions, vm meta
 *     stage.json          ← stage target
 *     sprites/
 *       <stableId>.json   ← one file per sprite, named by stable ID
 *
 * This layout means `git diff` between two commits shows exactly which
 * sprites changed — readable without any tooling.
 */
export class GitAdapter {
  constructor(private readonly repoPath: string) {}

  // ─── Setup ─────────────────────────────────────────────────────────────────

  /**
   * Initialize a git repo at repoPath (idempotent — safe to call on existing repo).
   * Sets a local identity so commits never fail in bare/CI environments.
   */
  init(): this {
    mkdirSync(this.repoPath, { recursive: true });
    this.git("init");
    // Local identity — only written if not already set
    try { this.git(`config user.email "scratch-git@local"`); } catch { /* already set */ }
    try { this.git(`config user.name "Scratch Git"`); } catch { /* already set */ }
    return this;
  }

  // ─── Read / write canonical project ────────────────────────────────────────

  /**
   * Write a CanonicalProject into the working tree as structured files.
   * Does NOT commit — call commit() after.
   */
  write(project: CanonicalProject): void {
    mkdirSync(join(this.repoPath, "sprites"), { recursive: true });

    for (const target of project.targets) {
      if (target.isStage) {
        this.writeJson("stage.json", target);
      } else {
        this.writeJson(join("sprites", `${target.stableId}.json`), target);
      }
    }

    this.writeJson("meta.json", {
      monitors: project.monitors,
      extensions: project.extensions,
      meta: project.meta,
    });
  }

  /**
   * Read a CanonicalProject from the working tree.
   * Call checkout() first if you want a specific ref.
   */
  read(): CanonicalProject {
    return this.readWorkingTree();
  }

  /**
   * Read a CanonicalProject at any git ref WITHOUT touching the working tree.
   * Uses `git show <ref>:<path>` — safe to call on any branch/tag/hash.
   */
  readAt(ref: string): CanonicalProject {
    return this.readAtRef(ref);
  }

  // ─── Git verbs ──────────────────────────────────────────────────────────────

  /**
   * Stage all changes and create a commit.
   * `--allow-empty` lets you commit even if nothing changed (idempotent).
   */
  commit(message: string): GitCommitResult {
    this.git("add -A");
    this.git(`commit -m ${shellQuote(message)} --allow-empty`);
    const hash = this.git("rev-parse HEAD").trim();
    const shortHash = this.git("rev-parse --short HEAD").trim();
    return { hash, shortHash, message };
  }

  /**
   * Checkout a branch, tag, or commit hash.
   * Returns the canonical project at that ref.
   */
  checkout(ref: string): CanonicalProject {
    this.git(`checkout ${ref}`);
    return this.readWorkingTree();
  }

  /**
   * Create and switch to a new branch.
   */
  branch(name: string): void {
    this.git(`checkout -b ${name}`);
  }

  /**
   * Switch to an existing branch without creating it.
   */
  switchBranch(name: string): void {
    this.git(`checkout ${name}`);
  }

  /**
   * List all local branches.
   */
  branches(): string[] {
    const raw = this.git("branch --format=%(refname:short)").trim();
    return raw ? raw.split("\n").map((b) => b.trim()) : [];
  }

  /**
   * Current branch name. Returns "HEAD" in detached-head state.
   */
  currentBranch(): string {
    const ref = this.git("symbolic-ref HEAD").trim(); // → refs/heads/master
    return ref.replace(/^refs\/heads\//, "");
  }

  /**
   * Structured git log.
   * Format: hash | shortHash | subject | author name | ISO date
   */
  log(count = 20): GitLogEntry[] {
    const fmt = "%H\x1f%h\x1f%s\x1f%an\x1f%ai";
    const raw = this.git(`log --format=${fmt} -n ${count}`).trim();
    if (!raw) return [];
    return raw.split("\n").map((line) => {
      const [hash, shortHash, message, author, date] = line.split("\x1f");
      return { hash, shortHash, message, author, date };
    });
  }

  /**
   * `git diff --stat` between two refs — human-readable change summary.
   */
  diffStat(from: string, to: string): string {
    return this.git(`diff --stat ${from}..${to}`);
  }

  /**
   * `git diff` raw output between two refs.
   */
  diffRaw(from: string, to: string): string {
    return this.git(`diff ${from}..${to}`);
  }

  /**
   * Whether the working tree has any uncommitted changes.
   */
  isDirty(): boolean {
    return this.git("status --porcelain").trim().length > 0;
  }

  /**
   * Working tree status as structured entries.
   */
  status(): GitStatusEntry[] {
    const raw = this.git("status --porcelain").trim();
    if (!raw) return [];
    return raw.split("\n").map((line) => ({
      status: line.slice(0, 2).trim(),
      path: line.slice(3).trim(),
    }));
  }

  /**
   * Resolve any git ref (branch, tag, HEAD, HEAD~2, short hash…) to a full hash.
   */
  resolve(ref: string): string {
    return this.git(`rev-parse ${ref}`).trim();
  }

  /**
   * Find the common ancestor of two refs (git merge-base).
   * Returns the full commit hash of the merge base.
   *
   * Used by MergeSession to locate the base project for 3-way merge.
   */
  mergeBase(ref1: string, ref2: string): string {
    return this.git(`merge-base ${ref1} ${ref2}`).trim();
  }

  /** @internal — called by MergeSession via duck-typing */
  _mergeBase(ref1: string, ref2: string): string {
    return this.mergeBase(ref1, ref2);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private git(command: string): string {
    return execSync(`git ${command}`, {
      cwd: this.repoPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  private writeJson(relativePath: string, data: unknown): void {
    const fullPath = join(this.repoPath, relativePath);
    writeFileSync(fullPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  private readJson(relativePath: string): unknown {
    return JSON.parse(readFileSync(join(this.repoPath, relativePath), "utf8"));
  }

  private readWorkingTree(): CanonicalProject {
    const meta  = this.readJson("meta.json") as any;
    const stage = this.readJson("stage.json") as CanonicalTarget;
    const targets: CanonicalTarget[] = [stage];

    const spritesDir = join(this.repoPath, "sprites");
    if (existsSync(spritesDir)) {
      for (const file of readdirSync(spritesDir).filter((f) => f.endsWith(".json"))) {
        targets.push(this.readJson(join("sprites", file)) as CanonicalTarget);
      }
    }

    return {
      targets,
      monitors: meta.monitors ?? [],
      extensions: meta.extensions ?? [],
      meta: meta.meta,
    };
  }

  private readAtRef(ref: string): CanonicalProject {
    const showFile = (path: string): unknown | null => {
      try {
        return JSON.parse(this.git(`show ${ref}:${path.replace(/\\/g, "/")}`));
      } catch {
        return null;
      }
    };

    const meta  = (showFile("meta.json") ?? {}) as any;
    const stage = showFile("stage.json") as CanonicalTarget | null;
    const targets: CanonicalTarget[] = stage ? [stage] : [];

    try {
      const listing = this.git(`ls-tree --name-only ${ref} sprites/`).trim();
      for (const filePath of listing.split("\n").filter(Boolean)) {
        const sprite = showFile(filePath) as CanonicalTarget | null;
        if (sprite) targets.push(sprite);
      }
    } catch { /* sprites/ dir may not exist at this ref */ }

    return {
      targets,
      monitors: meta.monitors ?? [],
      extensions: meta.extensions ?? [],
      meta: meta.meta,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shellQuote(str: string): string {
  return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
