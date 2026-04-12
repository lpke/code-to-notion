import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { GitContext } from "./types.js";
import * as logger from "./logger.js";

const MAX_BRANCHES = 20;
const BRANCH_TRUNCATE_THRESHOLD = 10;

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

/**
 * Gather comprehensive git context from a target directory.
 * Returns null if the directory is not a git repo or if branch count exceeds 20.
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
  const defaultBranch =
    git(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], absDir)?.replace(
      /^origin\//,
      "",
    ) || "unknown";
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
    { name: string; lastCommitDate: string; lastCommitHash: string }
  >();

  // Parse local branches
  if (localBranchesRaw) {
    for (const line of localBranchesRaw.split("\n")) {
      if (!line.trim()) continue;
      const [name, date, hash] = line.split("|");
      if (name) {
        branchMap.set(name, {
          name,
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
          lastCommitDate: date || "unknown",
          lastCommitHash: hash || "unknown",
        });
      }
    }
  }

  const totalBranchCount = branchMap.size;

  // Check branch limits
  if (totalBranchCount > MAX_BRANCHES) {
    logger.error(
      `Repository has ${totalBranchCount} branches which exceeds the maximum of ${MAX_BRANCHES}. Skipping git context.`,
    );
    return null;
  }

  let branchLimitApplied = false;

  // Sort branches by most recent commit date descending
  let sortedBranches = Array.from(branchMap.values()).sort((a, b) =>
    b.lastCommitDate.localeCompare(a.lastCommitDate),
  );

  if (totalBranchCount > BRANCH_TRUNCATE_THRESHOLD) {
    logger.warn(
      `Repository has ${totalBranchCount} branches. Only the ${BRANCH_TRUNCATE_THRESHOLD} most recent will be included.`,
    );
    sortedBranches = sortedBranches.slice(0, BRANCH_TRUNCATE_THRESHOLD);
    branchLimitApplied = true;
  }

  // --- 3. Commit History Per Branch ---
  const branches: GitContext["branches"] = [];

  for (const branch of sortedBranches) {
    const isCurrentBranch = branch.name === currentBranch;
    const isDefault = branch.name === defaultBranch;
    const commitLimit = isCurrentBranch || isDefault ? 30 : 15;

    const commitLogRaw = git(
      ["log", branch.name, "--format=%H|%h|%aI|%an|%ae|%s", "-n", String(commitLimit)],
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
        ["log", branch.name, "--format=---COMMIT_START---%H%n%B---COMMIT_END---", "-n", String(commitLimit)],
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

    branches.push({
      name: branch.name,
      lastCommitDate: branch.lastCommitDate,
      lastCommitHash: branch.lastCommitHash,
      isCurrentBranch,
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

  // Diffstat for the last 10 commits on the current branch
  let diffstatLast10 = "";
  // Check how many commits are available
  const commitCountStr = git(["rev-list", "--count", "HEAD"], absDir);
  const commitCount = commitCountStr ? parseInt(commitCountStr, 10) : 0;
  if (commitCount > 1) {
    const diffRange = commitCount >= 10 ? "HEAD~10..HEAD" : `HEAD~${commitCount - 1}..HEAD`;
    diffstatLast10 = git(["diff", "--stat", diffRange], absDir) || "";
  } else if (commitCount === 1) {
    // Single commit — diff against the empty tree to show initial changes
    diffstatLast10 = git(["diff", "--stat", "4b825dc642cb6eb9a060e54bf899d69f82cf7262", "HEAD"], absDir) || "";
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
  const tagsRaw = git(
    ["tag", "--sort=-creatordate", "--format=%(refname:short)|%(creatordate:iso-strict)|%(subject)"],
    absDir,
  );
  const tags: GitContext["tags"] = [];
  if (tagsRaw) {
    const tagLines = tagsRaw.split("\n").slice(0, 10);
    for (const line of tagLines) {
      if (!line.trim()) continue;
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

  // --- 6. Working Directory Status ---
  const statusRaw = git(["status", "--porcelain"], absDir);
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  if (statusRaw) {
    for (const line of statusRaw.split("\n")) {
      if (!line) continue;
      const x = line[0]; // index status
      const y = line[1]; // worktree status
      if (x === "?" && y === "?") {
        untracked++;
      } else {
        if (x && x !== " " && x !== "?") staged++;
        if (y && y !== " " && y !== "?") unstaged++;
      }
    }
  }

  const stashListRaw = git(["stash", "list"], absDir);
  const stashCount = stashListRaw
    ? stashListRaw.split("\n").filter((l) => l.trim()).length
    : 0;

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
      diffstatLast10,
      hotFiles,
      activeContributors,
    },
    tags,
    workingDirectory: {
      staged,
      unstaged,
      untracked,
      stashCount,
    },
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
