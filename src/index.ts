#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { upload } from "./upload.js";
import * as logger from "./logger.js";
import type { UploadOptions, GitLimits } from "./types.js";

import { DEFAULT_GIT_LIMITS } from "./git.js";

const program = new Command();

program
  .name("code-to-notion")
  .description("Upload codebases to Notion pages")
  .version("1.0.0")
  .showHelpAfterError(true)
  .argument("<dir>", "Target directory to upload")
  .option("--name <name>", "Override the project name (defaults to directory basename)")
  .option("--only <dirs...>", "Only include these subdirectories (relative to target dir)")
  .option("--ignore <patterns...>", "Additional glob patterns to ignore (on top of defaults)")
  .option("--dry-run", "Walk the tree and print what would be uploaded, without calling the API", false)
  .option("--concurrency <n>", "Max concurrent API requests (default: 2, max: 3)", "2")
  .option("--verbose", "Print detailed per-file progress", false)
  .option('--skip-git-context', 'Skip git context gathering even if .git exists', false)
  .option('--git-branches <n>', 'Max branches to include in git context (default: 20)')
  .option('--git-commits <n>', 'Max commits for the default branch (default: 50)')
  .option('--git-other-commits <n>', 'Max commits for non-default branches (default: 20)')
  .option('--git-tags <n>', 'Max tags to include (default: 10)')
  .option('--git-activity-days <n>', 'Recent activity window in days (default: 14)')
  .option('--git-hot-files <n>', 'Max hot files shown in recent activity (default: 30)')
  .option("--update", "Update existing upload if found (only upload changes)", false)
  .option("--replace", "Replace existing upload if found (delete and re-upload)", false)
  .action(async (dir: string, opts: {
    name?: string;
    only?: string[];
    ignore?: string[];
    dryRun: boolean;
    concurrency: string;
    verbose: boolean;
    skipGitContext: boolean;
    update: boolean;
    replace: boolean;
    gitBranches?: string;
    gitCommits?: string;
    gitOtherCommits?: string;
    gitTags?: string;
    gitActivityDays?: string;
    gitHotFiles?: string;
  }) => {
    try {
      // Validate mutually exclusive flags
      if (opts.update && opts.replace) {
        logger.error("--update and --replace are mutually exclusive.");
        process.exit(1);
      }

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

      // Build git limits from CLI flags with defaults
      const gitLimits: GitLimits = {
        branches: parseInt(opts.gitBranches!, 10) || DEFAULT_GIT_LIMITS.branches,
        defaultBranchCommits: parseInt(opts.gitCommits!, 10) || DEFAULT_GIT_LIMITS.defaultBranchCommits,
        otherBranchCommits: parseInt(opts.gitOtherCommits!, 10) || DEFAULT_GIT_LIMITS.otherBranchCommits,
        tags: parseInt(opts.gitTags!, 10) || DEFAULT_GIT_LIMITS.tags,
        activityDays: parseInt(opts.gitActivityDays!, 10) || DEFAULT_GIT_LIMITS.activityDays,
        hotFiles: parseInt(opts.gitHotFiles!, 10) || DEFAULT_GIT_LIMITS.hotFiles,
      };

      const options: UploadOptions = {
        dir: absDir,
        name: opts.name,
        only: opts.only,
        ignore: opts.ignore,
        dryRun: opts.dryRun,
        concurrency,
        verbose: opts.verbose,
        skipGitContext: opts.skipGitContext,
        update: opts.update || undefined,
        replace: opts.replace || undefined,
        gitLimits,
      };

      // Load config (only required for non-dry-run, or dry-run with --update/--replace)
      if (options.dryRun && !options.update && !options.replace) {
        // Pure dry run — no Notion credentials needed
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
