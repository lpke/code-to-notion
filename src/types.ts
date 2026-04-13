// Shared TypeScript types for code-to-pages

import type { LanguageRequest } from "@notionhq/client/build/src/api-endpoints/common.js";

/** Configuration loaded from env vars */
export interface Config {
  notionApiToken: string;
  notionCodebasesPageId: string;
}

/** Options passed from CLI to upload orchestration */
export interface UploadOptions {
  dir: string;
  name?: string;
  only?: string[];
  ignore?: string[];
  dryRun: boolean;
  concurrency: number;
  verbose: boolean;
  git: boolean;
}

/** A node in the file tree */
export interface FileNode {
  /** File or directory name */
  name: string;
  /** Relative path from the target dir root */
  path: string;
  /** Whether this is a file or directory */
  type: "file" | "directory";
  /** Children nodes (only for directories) */
  children?: FileNode[];
  /** File size in bytes (only for files) */
  size?: number;
  /** Detected language for syntax highlighting (only for files) */
  language?: LanguageRequest;
}

/** Tracks errors that occurred during upload */
export interface UploadError {
  filePath: string;
  error: Error;
}

/** Summary of the upload operation */
export interface UploadSummary {
  totalPages: number;
  totalFiles: number;
  totalDirectories: number;
  errors: UploadError[];
  skippedFiles: string[];
  rootPageId: string;
  elapsedMs: number;
}


/** Git context gathered from a repository */
export interface GitContext {
  remotes: Array<{ name: string; url: string }>;
  currentBranch: string;
  defaultBranch: string;
  totalCommits: number;
  repoAge: string;
  lastCommitDate: string;
  branches: Array<{
    name: string;
    lastCommitDate: string;
    lastCommitHash: string;
    isCurrentBranch: boolean;
    commits: Array<{
      hash: string;
      shortHash: string;
      date: string;
      author: string;
      email: string;
      subject: string;
      body?: string;
      diffstat?: string;
    }>;
  }>;
  recentActivity: {
    commitsLast7Days: Array<{
      shortHash: string;
      date: string;
      author: string;
      subject: string;
      branches: string;
    }>;
    diffstatLast100: string;
    hotFiles: Array<{ count: number; file: string }>;
    activeContributors: Array<{ commits: number; name: string }>;
  };
  tags: Array<{ name: string; date: string; subject: string }>;
  workingDirectory: {
    staged: number;
    unstaged: number;
    untracked: number;
    stashCount: number;
  };
  branchLimitApplied: boolean;
  totalBranchCount: number;
}
