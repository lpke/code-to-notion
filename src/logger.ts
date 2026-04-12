import chalk from "chalk";
import ora, { type Ora } from "ora";
import type { FileNode } from "./types.js";

let verboseMode = false;
let currentSpinner: Ora | null = null;

export function setVerbose(enabled: boolean): void {
  verboseMode = enabled;
}

export function info(message: string): void {
  pauseSpinner();
  console.log(chalk.cyan(message));
  resumeSpinner();
}

export function success(message: string): void {
  pauseSpinner();
  console.log(chalk.green(message));
  resumeSpinner();
}

export function warn(message: string): void {
  pauseSpinner();
  console.log(chalk.yellow(message));
  resumeSpinner();
}

export function error(message: string): void {
  pauseSpinner();
  console.error(chalk.red(message));
  resumeSpinner();
}

export function debug(message: string): void {
  if (!verboseMode) return;
  pauseSpinner();
  console.log(chalk.dim(message));
  resumeSpinner();
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

function pauseSpinner(): void {
  if (currentSpinner?.isSpinning) {
    currentSpinner.stop();
  }
}

function resumeSpinner(): void {
  if (currentSpinner && !currentSpinner.isSpinning) {
    currentSpinner.start();
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
}): void {
  stopSpinner();

  const notionUrl = `https://notion.so/${opts.rootPageId.replace(/-/g, "")}`;
  const timeStr = (opts.totalTime / 1000).toFixed(1);

  console.log("");
  console.log(chalk.green("═".repeat(50)));
  console.log(chalk.green.bold(" ✓ Upload complete!"));
  console.log(chalk.green("═".repeat(50)));
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
  console.log(chalk.green("═".repeat(50)));
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
