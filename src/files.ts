import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { FileNode } from "./types.js";
import type { LanguageRequest } from "@notionhq/client/build/src/api-endpoints/common.js";

/** Default directories to always ignore */
const DEFAULT_IGNORE_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  "coverage",
  "__pycache__",
];

/** Default file patterns to always ignore */
const DEFAULT_IGNORE_PATTERNS = [
  "**/.DS_Store",
  "**/*.lock",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/*.map",
  "**/*.min.js",
  "**/*.min.css",
  // Binary file extensions
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.ico",
  "**/*.svg",
  "**/*.woff",
  "**/*.woff2",
  "**/*.ttf",
  "**/*.eot",
  "**/*.mp3",
  "**/*.mp4",
  "**/*.zip",
  "**/*.tar",
  "**/*.gz",
  "**/*.pdf",
  "**/*.exe",
  "**/*.dll",
  "**/*.so",
  "**/*.dylib",
];

/** Map file extensions to Notion language identifiers */
const EXTENSION_LANGUAGE_MAP: Record<string, LanguageRequest> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".rb": "ruby",
  ".sh": "bash",
  ".bash": "bash",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".xml": "xml",
  ".lua": "lua",
  ".nix": "nix",
  ".vim": "plain text",
  ".c": "c",
  ".h": "c",
  ".cpp": "c++",
  ".hpp": "c++",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".php": "php",
  ".r": "r",
  ".scala": "scala",
  ".hs": "haskell",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".dart": "dart",
  ".cs": "c#",
  ".fs": "f#",
  ".ml": "ocaml",
  ".less": "less",
  ".sass": "sass",
};

/** Map special filenames to Notion language identifiers */
const FILENAME_LANGUAGE_MAP: Record<string, LanguageRequest> = {
  Dockerfile: "docker",
  Makefile: "makefile",
  ".dockerignore": "docker",
};

/** Detect language from a filename for Notion code block syntax highlighting */
export function detectLanguage(filename: string): LanguageRequest {
  // Check full filename first
  if (FILENAME_LANGUAGE_MAP[filename]) {
    return FILENAME_LANGUAGE_MAP[filename];
  }

  // Check if the filename starts with .env
  if (filename.startsWith(".env")) {
    return "bash";
  }

  // Check by extension
  const ext = path.extname(filename).toLowerCase();
  if (ext && EXTENSION_LANGUAGE_MAP[ext]) {
    return EXTENSION_LANGUAGE_MAP[ext];
  }

  return "plain text";
}

/**
 * Parse a .gitignore file and return glob patterns suitable for fast-glob ignore.
 */
function parseGitignore(gitignorePath: string): string[] {
  if (!fs.existsSync(gitignorePath)) {
    return [];
  }

  const content = fs.readFileSync(gitignorePath, "utf-8");
  const patterns: string[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    // Skip empty lines and comments
    if (!line || line.startsWith("#")) continue;
    // Skip negation patterns (not supported in simple ignore)
    if (line.startsWith("!")) continue;

    // Normalize: if it ends with /, it's a directory pattern
    let pattern = line;

    // Remove leading slash (means relative to root, which is our context anyway)
    if (pattern.startsWith("/")) {
      pattern = pattern.slice(1);
    }

    // If it doesn't contain a glob or slash, match anywhere
    if (!pattern.includes("/") && !pattern.includes("*")) {
      patterns.push(`**/${pattern}`);
      patterns.push(`**/${pattern}/**`);
    } else {
      patterns.push(pattern);
      // If it's a directory pattern, also match contents
      if (pattern.endsWith("/")) {
        patterns.push(`${pattern}**`);
      }
    }
  }

  return patterns;
}

/**
 * Build the complete list of ignore patterns from defaults, gitignore, and user patterns.
 */
function buildIgnorePatterns(
  rootDir: string,
  userIgnore?: string[],
): string[] {
  const patterns: string[] = [...DEFAULT_IGNORE_PATTERNS];

  // Add default directory ignores as glob patterns
  for (const dir of DEFAULT_IGNORE_DIRS) {
    patterns.push(`**/${dir}/**`);
    patterns.push(`${dir}/**`);
  }

  // Parse .gitignore
  const gitignorePath = path.join(rootDir, ".gitignore");
  patterns.push(...parseGitignore(gitignorePath));

  // Add user-provided ignore patterns
  if (userIgnore) {
    for (const pat of userIgnore) {
      // If pattern doesn't start with ** or contain /, make it match anywhere
      if (!pat.startsWith("**") && !pat.includes("/")) {
        patterns.push(`**/${pat}`);
      } else {
        patterns.push(pat);
      }
    }
  }

  return patterns;
}

/**
 * Build glob source patterns based on --only flags.
 * When --only is provided, include:
 *   1. Root files of the target dir (files directly in rootDir)
 *   2. Everything inside the specified subdirectories
 * When --only is NOT provided, include everything.
 */
function buildSourcePatterns(only?: string[]): string[] {
  if (!only || only.length === 0) {
    return ["**/*"];
  }

  const patterns: string[] = ["*"]; // Root files always included
  for (const dir of only) {
    // Normalize: remove trailing slash
    const d = dir.replace(/\/+$/, "");
    patterns.push(`${d}/**/*`);
  }

  return patterns;
}

/**
 * Walk a directory and build a tree of FileNode objects.
 */
export async function buildFileTree(
  rootDir: string,
  options?: { only?: string[]; ignore?: string[] },
): Promise<FileNode> {
  const absRoot = path.resolve(rootDir);
  const dirName = path.basename(absRoot);

  const ignorePatterns = buildIgnorePatterns(absRoot, options?.ignore);
  const sourcePatterns = buildSourcePatterns(options?.only);

  // Use fast-glob to find all matching files
  const files = await fg(sourcePatterns, {
    cwd: absRoot,
    dot: true,
    onlyFiles: true,
    ignore: ignorePatterns,
  });

  // Sort files for consistent ordering
  files.sort();

  // Build tree from flat file list
  const root: FileNode = {
    name: dirName,
    path: ".",
    type: "directory",
    children: [],
  };

  for (const relPath of files) {
    const parts = relPath.split("/");
    const absPath = path.join(absRoot, relPath);
    let stat: fs.Stats;

    try {
      stat = fs.statSync(absPath);
    } catch {
      continue; // Skip files we can't stat
    }

    // Skip empty files
    if (stat.size === 0) continue;

    // Navigate/create directory nodes along the path
    let currentNode = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPart = parts[i];
      const dirPath = parts.slice(0, i + 1).join("/");
      let dirNode = currentNode.children?.find(
        (c) => c.name === dirPart && c.type === "directory",
      );

      if (!dirNode) {
        dirNode = {
          name: dirPart,
          path: dirPath,
          type: "directory",
          children: [],
        };
        currentNode.children!.push(dirNode);
      }

      currentNode = dirNode;
    }

    // Add the file node
    const fileName = parts[parts.length - 1];
    currentNode.children!.push({
      name: fileName,
      path: relPath,
      type: "file",
      size: stat.size,
      language: detectLanguage(fileName),
    });
  }

  // Sort tree: directories first (alphabetical), then files (alphabetical)
  sortTree(root);

  // Prune empty directories
  pruneEmptyDirs(root);

  return root;
}

/** Recursively sort children: directories first (alphabetical), then files (alphabetical) */
function sortTree(node: FileNode): void {
  if (!node.children) return;

  node.children.sort((a, b) => {
    // Directories before files
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1;
    }
    // Alphabetical within same type
    return a.name.localeCompare(b.name);
  });

  for (const child of node.children) {
    if (child.type === "directory") {
      sortTree(child);
    }
  }
}

/** Remove directories that have no files (directly or transitively) */
function pruneEmptyDirs(node: FileNode): boolean {
  if (node.type === "file") return true;
  if (!node.children) return false;

  // Recursively prune children
  node.children = node.children.filter((child) => pruneEmptyDirs(child));

  return node.children.length > 0;
}

/** Count files and directories in a tree */
export function countNodes(node: FileNode): {
  files: number;
  directories: number;
} {
  if (node.type === "file") {
    return { files: 1, directories: 0 };
  }

  let files = 0;
  let directories = 1; // count this directory

  if (node.children) {
    for (const child of node.children) {
      const counts = countNodes(child);
      files += counts.files;
      directories += counts.directories;
    }
  }

  return { files, directories };
}

/** Read file content, with truncation for very large files */
export function readFileContent(absPath: string, size: number): {
  content: string;
  truncated: boolean;
} {
  const MAX_FILE_SIZE = 500 * 1024; // 500KB

  if (size > MAX_FILE_SIZE) {
    // Read only the first 500KB
    const fd = fs.openSync(absPath, "r");
    const buffer = Buffer.alloc(MAX_FILE_SIZE);
    fs.readSync(fd, buffer, 0, MAX_FILE_SIZE, 0);
    fs.closeSync(fd);
    return { content: buffer.toString("utf-8"), truncated: true };
  }

  return { content: fs.readFileSync(absPath, "utf-8"), truncated: false };
}

/** Format bytes to human-readable string */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Collect all ignore patterns as a display-friendly list */
export function getIgnorePatternsDisplay(
  rootDir: string,
  userIgnore?: string[],
): string[] {
  const display: string[] = [
    ...DEFAULT_IGNORE_DIRS.map((d) => `${d}/`),
    "*.lock",
    "*.map",
    "*.min.js",
    "*.min.css",
    "(binary files)",
  ];

  // Show gitignore patterns if present
  const gitignorePath = path.join(path.resolve(rootDir), ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    display.push("(.gitignore rules)");
  }

  if (userIgnore && userIgnore.length > 0) {
    display.push(...userIgnore);
  }

  return display;
}
