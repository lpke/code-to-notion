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
