import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { GitContext } from "./types.js";
import * as logger from "./logger.js";

const BRANCH_LIMIT = 20;

/**
 * Run a git command in the target directory. Returns stdout as a trimmed string.
 * Returns null if the command fails.
 */
function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Git command failed: git ${args.join(" ")} — ${message}`);
    return null;
  }
}

/** Normalize git --stat output: each line has a leading space; strip it for consistency. */
function normalizeDiffstat(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/^ /, ""))
    .join("\n")
    .trim();
}

/**
 * Gather comprehensive git context from a target directory.
 * Returns null if the directory is not a git repo.
 * If there are more than 20 branches, only the 20 most recently touched are included
 * (the default branch is always included).
 */
export async function gatherGitContext(
  targetDir: string,
): Promise<GitContext | null> {
  const absDir = path.resolve(targetDir);

  // Check if it's a git repo
  if (!fs.existsSync(path.join(absDir, ".git"))) {
    logger.debug("Not a git repository, skipping git context.");
    return null;
  }

  // --- 1. Repository Info ---
  const remotes = parseRemotes(git(["remote", "-v"], absDir));
  const currentBranch = git(["branch", "--show-current"], absDir) || "HEAD";
  const defaultBranch = detectDefaultBranch(absDir);
  const totalCommitsStr = git(["rev-list", "--count", "HEAD"], absDir);
  const totalCommits = totalCommitsStr ? parseInt(totalCommitsStr, 10) : 0;
  const repoAge =
    git(["log", "--reverse", "--format=%aI"], absDir)?.split("\n")[0] || "unknown";
  const lastCommitDate = git(["log", "-1", "--format=%aI"], absDir) || "unknown";

  // --- 2. Branch Management ---
  const localBranchesRaw = git(
    ["branch", "--format=%(refname:short)|%(committerdate:iso-strict)|%(objectname:short)"],
    absDir,
  );
  const remoteBranchesRaw = git(
    ["branch", "-r", "--format=%(refname:short)|%(committerdate:iso-strict)|%(objectname:short)"],
    absDir,
  );

  const branchMap = new Map<
    string,
    { name: string; gitRef: string; lastCommitDate: string; lastCommitHash: string }
  >();

  // Parse local branches
  if (localBranchesRaw) {
    for (const line of localBranchesRaw.split("\n")) {
      if (!line.trim()) continue;
      const [name, date, hash] = line.split("|");
      if (name) {
        branchMap.set(name, {
          name,
          gitRef: name,
          lastCommitDate: date || "unknown",
          lastCommitHash: hash || "unknown",
        });
      }
    }
  }

  // Parse remote branches — prefer remote tracking info where both exist
  if (remoteBranchesRaw) {
    for (const line of remoteBranchesRaw.split("\n")) {
      if (!line.trim()) continue;
      const [rawName, date, hash] = line.split("|");
      if (!rawName) continue;
      // Filter out HEAD pointers
      if (rawName.includes("/HEAD")) continue;
      // Strip origin/ prefix for dedup
      const shortName = rawName.replace(/^[^/]+\//, "");
      // Only add if not already present from local branches
      if (!branchMap.has(shortName)) {
        branchMap.set(shortName, {
          name: shortName,
          gitRef: rawName,
          lastCommitDate: date || "unknown",
          lastCommitHash: hash || "unknown",
        });
      }
    }
  }

  const totalBranchCount = branchMap.size;

  let branchLimitApplied = false;

  // Sort branches by most recent commit date descending
  let sortedBranches = Array.from(branchMap.values()).sort((a, b) =>
    b.lastCommitDate.localeCompare(a.lastCommitDate),
  );

  if (totalBranchCount > BRANCH_LIMIT) {
    logger.warn(
      `Repository has ${totalBranchCount} branches. Only the ${BRANCH_LIMIT} most recent will be included.`,
    );

    // Always include the default branch, even if it's not in the top N by date
    const defaultBranchEntry = sortedBranches.find((b) => b.name === defaultBranch);
    const topBranches = sortedBranches.slice(0, BRANCH_LIMIT);
    if (defaultBranchEntry && !topBranches.some((b) => b.name === defaultBranch)) {
      // Replace the last entry with the default branch
      topBranches[topBranches.length - 1] = defaultBranchEntry;
    }
    sortedBranches = topBranches;
    branchLimitApplied = true;
  }

  // --- 3. Commit History Per Branch ---
  const branches: GitContext["branches"] = [];

  for (const branch of sortedBranches) {
    const isCurrentBranch = branch.name === currentBranch;
    const commitLimit = 50;

    // Get total commit count for this branch (to detect truncation)
    const totalBranchCommitsStr = git(["rev-list", "--count", branch.gitRef], absDir);
    const totalBranchCommits = totalBranchCommitsStr ? parseInt(totalBranchCommitsStr, 10) : 0;

    const commitLogRaw = git(
      ["log", branch.gitRef, "--format=%H|%h|%aI|%an|%ae|%s", "-n", String(commitLimit)],
      absDir,
    );

    const commits: GitContext["branches"][0]["commits"] = [];

    if (commitLogRaw) {
      for (const line of commitLogRaw.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("|");
        if (parts.length >= 6) {
          commits.push({
            hash: parts[0],
            shortHash: parts[1],
            date: parts[2],
            author: parts[3],
            email: parts[4],
            subject: parts.slice(5).join("|"), // subject may contain |
          });
        }
      }
    }

    // Get full commit messages for this branch
    if (commits.length > 0) {
      const fullMessagesRaw = git(
        ["log", branch.gitRef, "--format=---COMMIT_START---%H%n%B---COMMIT_END---", "-n", String(commitLimit)],
        absDir,
      );

      if (fullMessagesRaw) {
        const commitBlocks = fullMessagesRaw
          .split("---COMMIT_START---")
          .filter((b) => b.trim());

        for (const block of commitBlocks) {
          const endIdx = block.indexOf("---COMMIT_END---");
          const content = endIdx !== -1 ? block.slice(0, endIdx) : block;
          const newlineIdx = content.indexOf("\n");
          if (newlineIdx === -1) continue;
          const hash = content.slice(0, newlineIdx).trim();
          const body = content.slice(newlineIdx + 1).trim();

          // Find the matching commit and add the body
          const commit = commits.find((c) => c.hash === hash);
          if (commit) {
            // The body from %B includes the subject line, so extract just the body portion
            const lines = body.split("\n");
            // First line is the subject, rest is the body
            const bodyPart = lines.slice(1).join("\n").trim();
            if (bodyPart) {
              commit.body = bodyPart;
            }
          }
        }
      }
    }

    // Get per-commit diffstats for up to the last 50 commits on this branch
    if (commits.length > 0) {
      const diffstatRaw = git(
        ["log", branch.gitRef, "--format=---DIFFSTAT_START---%h", "--stat", "-n", String(commitLimit)],
        absDir,
      );

      if (diffstatRaw) {
        const chunks = diffstatRaw.split("---DIFFSTAT_START---").filter((c) => c.trim());
        for (const chunk of chunks) {
          const lines = chunk.split("\n");
          const shortHash = lines[0].trim();
          const diffstat = normalizeDiffstat(lines.slice(1).join("\n"));
          if (shortHash && diffstat) {
            const commit = commits.find((c) => c.shortHash === shortHash);
            if (commit) {
              commit.diffstat = diffstat;
            }
          }
        }
      }
    }

    branches.push({
      name: branch.name,
      lastCommitDate: branch.lastCommitDate,
      lastCommitHash: branch.lastCommitHash,
      isCurrentBranch,
      totalCommitCount: totalBranchCommits,
      commits,
    });
  }

  // --- 4. Recent Changes (Last 7 Days) ---
  const recentCommitsRaw = git(
    ["log", "--all", "--after=7 days ago", "--format=%h|%aI|%an|%s|%D", "--date=iso-strict"],
    absDir,
  );
  const commitsLast7Days: GitContext["recentActivity"]["commitsLast7Days"] = [];
  if (recentCommitsRaw) {
    for (const line of recentCommitsRaw.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("|");
      if (parts.length >= 4) {
        commitsLast7Days.push({
          shortHash: parts[0],
          date: parts[1],
          author: parts[2],
          subject: parts[3],
          branches: parts[4] || "",
        });
      }
    }
  }

  // Diffstat for the last 20 commits on the current branch
  let diffstatLast20 = "";
  // Check how many commits are available
  const commitCountStr = git(["rev-list", "--count", "HEAD"], absDir);
  const commitCount = commitCountStr ? parseInt(commitCountStr, 10) : 0;
  if (commitCount > 1) {
    const diffRange = commitCount >= 20 ? "HEAD~20..HEAD" : `HEAD~${commitCount - 1}..HEAD`;
    diffstatLast20 = normalizeDiffstat(git(["diff", "--stat", diffRange], absDir) || "");
  } else if (commitCount === 1) {
    // Single commit — diff against the empty tree to show initial changes
    diffstatLast20 = normalizeDiffstat(git(["diff", "--stat", "4b825dc642cb6eb9a060e54bf899d69f82cf7262", "HEAD"], absDir) || "");
  }

  // Files changed in the last 7 days (most frequently changed)
  const hotFilesRaw = git(
    ["log", "--all", "--after=7 days ago", "--name-only", "--format="],
    absDir,
  );
  const hotFiles: GitContext["recentActivity"]["hotFiles"] = [];
  if (hotFilesRaw) {
    const fileCounts = new Map<string, number>();
    for (const line of hotFilesRaw.split("\n")) {
      const file = line.trim();
      if (!file) continue;
      fileCounts.set(file, (fileCounts.get(file) || 0) + 1);
    }
    const sorted = Array.from(fileCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30);
    for (const [file, count] of sorted) {
      hotFiles.push({ count, file });
    }
  }

  // Active contributors in the last 30 days
  const contributorsRaw = git(
    ["log", "--all", "--after=30 days ago", "--format=%an <%ae>"],
    absDir,
  );
  const activeContributors: GitContext["recentActivity"]["activeContributors"] =
    [];
  if (contributorsRaw) {
    const contribCounts = new Map<string, number>();
    for (const line of contributorsRaw.split("\n")) {
      const name = line.trim();
      if (!name) continue;
      contribCounts.set(name, (contribCounts.get(name) || 0) + 1);
    }
    const sorted = Array.from(contribCounts.entries()).sort(
      (a, b) => b[1] - a[1],
    );
    for (const [name, commits] of sorted) {
      activeContributors.push({ commits, name });
    }
  }

  // --- 5. Tags ---
  const TAG_LIMIT = 10;
  const tagsRaw = git(
    ["tag", "--sort=-creatordate", "--format=%(refname:short)|%(creatordate:iso-strict)|%(subject)"],
    absDir,
  );
  const tags: GitContext["tags"] = [];
  let totalTagCount = 0;
  if (tagsRaw) {
    const allTagLines = tagsRaw.split("\n").filter((l) => l.trim());
    totalTagCount = allTagLines.length;
    const tagLines = allTagLines.slice(0, TAG_LIMIT);
    for (const line of tagLines) {
      const parts = line.split("|");
      if (parts.length >= 1) {
        tags.push({
          name: parts[0],
          date: parts[1] || "unknown",
          subject: parts.slice(2).join("|") || "",
        });
      }
    }
  }

  return {
    remotes,
    currentBranch,
    defaultBranch,
    totalCommits,
    repoAge,
    lastCommitDate,
    branches,
    recentActivity: {
      commitsLast7Days,
      diffstatLast20,
      hotFiles,
      activeContributors,
    },
    tags,
    totalTagCount,
    branchLimitApplied,
    totalBranchCount,
  };
}

/**
 * Parse `git remote -v` output into deduplicated remote entries.
 */
function parseRemotes(
  raw: string | null,
): Array<{ name: string; url: string }> {
  if (!raw) return [];

  const seen = new Set<string>();
  const remotes: Array<{ name: string; url: string }> = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    // Format: "origin\thttps://github.com/... (fetch)"
    const match = line.match(/^(\S+)\s+(\S+)\s+/);
    if (match) {
      const key = `${match[1]}|${match[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        remotes.push({ name: match[1], url: match[2] });
      }
    }
  }

  return remotes;
}

/**
 * Detect the default branch for the repository using multiple strategies:
 * 1. git symbolic-ref refs/remotes/origin/HEAD (works when the ref exists)
 * 2. git ls-remote --symref origin HEAD (queries the remote directly)
 * 3. Fall back to "main" or "master" if either exists locally
 */
function detectDefaultBranch(cwd: string): string {
  // Strategy 1: local symbolic ref (fast, no network)
  const symref = git(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], cwd);
  if (symref) {
    return symref.replace(/^origin\//, "");
  }

  // Strategy 2: ask the remote (requires network but works when strategy 1 fails)
  const lsRemote = git(["ls-remote", "--symref", "origin", "HEAD"], cwd);
  if (lsRemote) {
    // Output looks like: "ref: refs/heads/main\tHEAD\n<hash>\tHEAD"
    const match = lsRemote.match(/ref:\s+refs\/heads\/(\S+)/);
    if (match) {
      return match[1];
    }
  }

  // Strategy 3: check for common default branch names locally
  const localBranches = git(["branch", "--format=%(refname:short)"], cwd);
  if (localBranches) {
    const branches = localBranches.split("\n").map((b) => b.trim());
    if (branches.includes("main")) return "main";
    if (branches.includes("master")) return "master";
  }

  return "unknown";
}
