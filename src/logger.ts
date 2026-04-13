import chalk from "chalk";
import ora, { type Ora } from "ora";
import type { FileNode } from "./types.js";

let verboseMode = false;
let currentSpinner: Ora | null = null;
let cancelled = false;
let cleanupKeyListener: (() => void) | null = null;

export function setVerbose(enabled: boolean): void {
  verboseMode = enabled;
}

// --- Cancellation ---

export class CancelledError extends Error {
  constructor() {
    super("Upload cancelled by user");
    this.name = "CancelledError";
  }
}

export function isCancelled(): boolean {
  return cancelled;
}

export function throwIfCancelled(): void {
  if (cancelled) throw new CancelledError();
}

/**
 * Start listening for cancellation signals: `q` keypress or ctrl+c.
 * Call `stopCancellationListener()` to clean up.
 */
export function startCancellationListener(): void {
  cancelled = false;

  const onCancel = () => {
    if (cancelled) {
      // Second press — force exit
      process.exit(1);
    }
    cancelled = true;
    writeLineAboveSpinner(chalk.yellow("\n⚠ Cancelling after current operation completes... (press again to force quit)"));
  };

  // Listen for SIGINT (ctrl+c)
  process.on("SIGINT", onCancel);

  // Listen for `q` keypress (only if stdin is a TTY)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");

    const onData = (key: string) => {
      // ctrl+c comes through as \x03 in raw mode
      if (key === "q" || key === "\x03") {
        onCancel();
      }
    };
    process.stdin.on("data", onData);

    cleanupKeyListener = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.removeListener("SIGINT", onCancel);
    };
  } else {
    cleanupKeyListener = () => {
      process.removeListener("SIGINT", onCancel);
    };
  }
}

export function stopCancellationListener(): void {
  if (cleanupKeyListener) {
    cleanupKeyListener();
    cleanupKeyListener = null;
  }
}

// --- Logging (flicker-free) ---

/**
 * Write a line above the spinner without stopping/restarting it.
 * This avoids the flicker caused by the previous pauseSpinner/resumeSpinner approach.
 */
function writeLineAboveSpinner(line: string): void {
  if (currentSpinner?.isSpinning) {
    currentSpinner.clear();
    process.stderr.write(line + "\n");
    currentSpinner.render();
  } else {
    process.stderr.write(line + "\n");
  }
}

export function info(message: string): void {
  writeLineAboveSpinner(chalk.cyan(message));
}

export function success(message: string): void {
  writeLineAboveSpinner(chalk.green(message));
}

export function warn(message: string): void {
  writeLineAboveSpinner(chalk.yellow(message));
}

export function error(message: string): void {
  writeLineAboveSpinner(chalk.red(message));
}

export function debug(message: string): void {
  if (!verboseMode) return;
  writeLineAboveSpinner(chalk.dim(message));
}

export function startSpinner(text: string): Ora {
  if (currentSpinner) {
    currentSpinner.text = text;
    return currentSpinner;
  }
  currentSpinner = ora({ text, color: "cyan" }).start();
  return currentSpinner;
}

export function updateSpinner(text: string): void {
  if (currentSpinner) {
    currentSpinner.text = text;
  }
}

export function succeedSpinner(text: string): void {
  if (currentSpinner) {
    currentSpinner.succeed(chalk.green(text));
    currentSpinner = null;
  }
}

export function failSpinner(text: string): void {
  if (currentSpinner) {
    currentSpinner.fail(chalk.red(text));
    currentSpinner = null;
  }
}

export function stopSpinner(): void {
  if (currentSpinner) {
    currentSpinner.stop();
    currentSpinner = null;
  }
}

export function printProgress(
  current: number,
  total: number,
  filePath: string,
): void {
  const text = chalk.cyan(`[${current}/${total}]`) + ` Uploading ${filePath}`;
  if (currentSpinner) {
    currentSpinner.text = text;
  } else {
    startSpinner(text);
  }
}

export function printSummary(opts: {
  totalPages: number;
  totalTime: number;
  errors: Array<{ filePath: string; error: Error }>;
  rootPageId: string;
  wasCancelled?: boolean;
}): void {
  stopSpinner();

  const notionUrl = `https://notion.so/${opts.rootPageId.replace(/-/g, "")}`;
  const timeStr = (opts.totalTime / 1000).toFixed(1);

  console.log("");
  if (opts.wasCancelled) {
    console.log(chalk.yellow("═".repeat(50)));
    console.log(chalk.yellow.bold(" ⚠ Upload cancelled"));
    console.log(chalk.yellow("═".repeat(50)));
  } else {
    console.log(chalk.green("═".repeat(50)));
    console.log(chalk.green.bold(" ✓ Upload complete!"));
    console.log(chalk.green("═".repeat(50)));
  }
  console.log(`  ${chalk.cyan("Pages created:")} ${opts.totalPages}`);
  console.log(`  ${chalk.cyan("Time elapsed:")}  ${timeStr}s`);

  if (opts.errors.length > 0) {
    console.log(
      `  ${chalk.red("Errors:")}         ${opts.errors.length} file(s) failed`,
    );
    for (const err of opts.errors) {
      console.log(chalk.red(`    ✗ ${err.filePath}: ${err.error.message}`));
    }
  }

  console.log(`  ${chalk.cyan("Notion page:")}   ${notionUrl}`);
  const borderColor = opts.wasCancelled ? chalk.yellow : chalk.green;
  console.log(borderColor("═".repeat(50)));
  console.log("");
}

export function printTree(node: FileNode, prefix: string = "", isRoot: boolean = true): void {
  const icon = node.type === "directory" ? "📁" : "📄";

  if (isRoot) {
    console.log(`${icon} ${chalk.bold(node.name)}`);
  } else {
    console.log(`${prefix}${icon} ${node.name}`);
  }

  if (node.type === "directory" && node.children) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const isLast = i === node.children.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";
      const newPrefix = isRoot ? connector : prefix + connector;
      const nextPrefix = isRoot ? childPrefix : prefix + childPrefix;
      printTreeChild(child, newPrefix, nextPrefix);
    }
  }
}

function printTreeChild(node: FileNode, linePrefix: string, childrenPrefix: string): void {
  const icon = node.type === "directory" ? "📁" : "📄";
  console.log(`${linePrefix}${icon} ${node.name}`);

  if (node.type === "directory" && node.children) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const isLast = i === node.children.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const nextChildPrefix = isLast ? "    " : "│   ";
      printTreeChild(child, childrenPrefix + connector, childrenPrefix + nextChildPrefix);
    }
  }
}

