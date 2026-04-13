// Shared TypeScript types for code-to-notion

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
  skipGitContext: boolean;
  update?: boolean;
  replace?: boolean;
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
    totalCommitCount: number;
    commits: Array<{
      hash: string;
      shortHash: string;
      date: string;
      author: string;
      email: string;
      subject: string;
      body?: string;
      diffstat?: string;
      /** True if this commit was already shown in full in an earlier branch */
      deduplicated?: boolean;
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
    diffstatLast20: string;
    hotFiles: Array<{ count: number; file: string }>;
    activeContributors: Array<{ commits: number; name: string }>;
  };
  tags: Array<{ name: string; date: string; subject: string }>;
  totalTagCount: number;
  branchLimitApplied: boolean;
  totalBranchCount: number;
}



/** A single file entry in the manifest */
export interface ManifestFileEntry {
  pageId: string;
  hash: string;
  size: number;
}

/** A single directory entry in the manifest */
export interface ManifestDirEntry {
  pageId: string;
}

/** The manifest stored as JSON in a .manifest child page */
export interface Manifest {
  version: 1;
  createdAt: string;
  updatedAt: string;
  rootPageId: string;
  gitContextPageId?: string;
  files: Record<string, ManifestFileEntry>;
  directories: Record<string, ManifestDirEntry>;
}

/** Diff between local file state and the remote manifest */
export interface ManifestDiff {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
  addedDirs: string[];
  deletedDirs: string[];
}

/** Action to take when a project with the same name already exists */
export type ExistingAction = 'update' | 'replace' | 'new' | 'cancel';

/** Accumulator for building a manifest during upload */
export interface ManifestBuilder {
  files: Record<string, ManifestFileEntry>;
  directories: Record<string, ManifestDirEntry>;
}
