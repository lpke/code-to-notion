#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { upload } from "./upload.js";
import * as logger from "./logger.js";
import type { UploadOptions } from "./types.js";

const program = new Command();

program
  .name("code-to-pages")
  .description("Upload codebases to Notion pages")
  .version("1.0.0")
  .argument("<dir>", "Target directory to upload")
  .option("--name <name>", "Override the project name (defaults to directory basename)")
  .option("--only <dirs...>", "Only include these subdirectories (relative to target dir)")
  .option("--ignore <patterns...>", "Additional glob patterns to ignore (on top of defaults)")
  .option("--dry-run", "Walk the tree and print what would be uploaded, without calling the API", false)
  .option("--concurrency <n>", "Max concurrent API requests (default: 2, max: 3)", "2")
  .option("--verbose", "Print detailed per-file progress", false)
  .option("--skip-git-context", "Skip git context gathering even if .git exists", false)
  .action(async (dir: string, opts: {
    name?: string;
    only?: string[];
    ignore?: string[];
    dryRun: boolean;
    concurrency: string;
    verbose: boolean;
    skipGitContext: boolean;
  }) => {
    try {
      // Validate directory exists
      const absDir = path.resolve(dir);
      if (!fs.existsSync(absDir)) {
        logger.error(`Error: Directory does not exist: ${absDir}`);
        process.exit(1);
      }
      if (!fs.statSync(absDir).isDirectory()) {
        logger.error(`Error: Not a directory: ${absDir}`);
        process.exit(1);
      }

      // Parse concurrency
      const concurrency = Math.min(Math.max(parseInt(opts.concurrency, 10) || 2, 1), 3);

      const options: UploadOptions = {
        dir: absDir,
        name: opts.name,
        only: opts.only,
        ignore: opts.ignore,
        dryRun: opts.dryRun,
        concurrency,
        verbose: opts.verbose,
        skipGitContext: opts.skipGitContext,
      };

      // Load config (only required for non-dry-run)
      if (options.dryRun) {
        // For dry run, we don't need Notion credentials
        await upload(options, {
          notionApiToken: "",
          notionCodebasesPageId: "",
        });
      } else {
        const config = loadConfig();
        await upload(options, config);
      }
    } catch (err: unknown) {
      // Top-level errors are already handled in upload.ts
      // This catches anything that falls through
      process.exit(1);
    }
  });

program.parse();
