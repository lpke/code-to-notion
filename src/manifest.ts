import crypto from "node:crypto";
import type {
  FileNode,
  Manifest,
  ManifestFileEntry,
  ManifestDirEntry,
  ManifestDiff,
} from "./types.js";
import { readFileContent } from "./files.js";
import path from "node:path";

/** Compute SHA-256 hex hash of a string */
export function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

/** Information about a local file used for manifest diffing */
export interface LocalFileInfo {
  path: string;
  hash: string;
  size: number;
}

/**
 * Recursively walk a FileNode tree and build a Map of relative path -> LocalFileInfo.
 * Reads each file's content to compute its SHA-256 hash.
 */
export function buildLocalFileMap(
  tree: FileNode,
  absRoot: string,
): Map<string, LocalFileInfo> {
  const map = new Map<string, LocalFileInfo>();
  walkFiles(tree, absRoot, map);
  return map;
}

function walkFiles(
  node: FileNode,
  absRoot: string,
  map: Map<string, LocalFileInfo>,
): void {
  if (node.type === "file" && node.size !== undefined) {
    const absPath = path.join(absRoot, node.path);
    const { content } = readFileContent(absPath, node.size);
    const hash = computeHash(content);
    map.set(node.path, { path: node.path, hash, size: node.size });
  }

  if (node.children) {
    for (const child of node.children) {
      walkFiles(child, absRoot, map);
    }
  }
}

/**
 * Recursively collect all directory paths from the tree, excluding the root ".".
 */
export function collectDirPaths(tree: FileNode): Set<string> {
  const dirs = new Set<string>();
  walkDirs(tree, dirs);
  return dirs;
}

function walkDirs(node: FileNode, dirs: Set<string>): void {
  if (node.type === "directory" && node.path !== ".") {
    dirs.add(node.path);
  }
  if (node.children) {
    for (const child of node.children) {
      walkDirs(child, dirs);
    }
  }
}

/**
 * Diff local file state against a remote manifest.
 */
export function diffManifest(
  localFiles: Map<string, LocalFileInfo>,
  localDirs: Set<string>,
  remote: Manifest,
): ManifestDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const unchanged: string[] = [];

  // Check local files against remote
  for (const [filePath, local] of localFiles) {
    const remoteEntry = remote.files[filePath];
    if (!remoteEntry) {
      added.push(filePath);
    } else if (remoteEntry.hash !== local.hash) {
      modified.push(filePath);
    } else {
      unchanged.push(filePath);
    }
  }

  // Check for deleted files (in remote but not local)
  for (const filePath of Object.keys(remote.files)) {
    if (!localFiles.has(filePath)) {
      deleted.push(filePath);
    }
  }

  // Directory diffs
  const remoteDirPaths = new Set(Object.keys(remote.directories));

  const addedDirs: string[] = [];
  for (const dirPath of localDirs) {
    if (!remoteDirPaths.has(dirPath)) {
      addedDirs.push(dirPath);
    }
  }
  // Sort alphabetically (top-down creation order)
  addedDirs.sort();

  const deletedDirs: string[] = [];
  for (const dirPath of remoteDirPaths) {
    if (!localDirs.has(dirPath)) {
      deletedDirs.push(dirPath);
    }
  }
  // Sort reverse-alphabetically (bottom-up deletion order)
  deletedDirs.sort().reverse();

  return { added, modified, deleted, unchanged, addedDirs, deletedDirs };
}

/**
 * Build a Manifest object from the given data.
 */
export function buildManifest(
  rootPageId: string,
  files: Record<string, ManifestFileEntry>,
  directories: Record<string, ManifestDirEntry>,
  gitContextPageId?: string,
  existingCreatedAt?: string,
): Manifest {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: existingCreatedAt || now,
    updatedAt: now,
    rootPageId,
    ...(gitContextPageId ? { gitContextPageId } : {}),
    files,
    directories,
  };
}
