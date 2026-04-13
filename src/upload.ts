import path from "node:path";
import {
  APIResponseError,
  APIErrorCode,
  isNotionClientError,
} from "@notionhq/client";
import type { FileNode, UploadOptions, UploadError } from "./types.js";
import {
  buildFileTree,
  countNodes,
  readFileContent,
  formatBytes,
  getIgnorePatternsDisplay,
} from "./files.js";
import { chunkFileContent } from "./chunker.js";
import {
  initNotion,
  createNotionPage,
  createDirectoryPage,
  createFilePage,
  appendCodeBlocks,
  appendMetadataBlock,
  appendRootCallout,
  appendGitContextPage,
} from "./notion.js";
import * as logger from "./logger.js";
import { gatherGitContext } from "./git.js";
import type { Config } from "./types.js";

const MAX_RETRIES = 3;

export async function upload(
  options: UploadOptions,
  config: Config,
): Promise<void> {
  const absDir = path.resolve(options.dir);
  const projectName = options.name || path.basename(absDir);

  logger.setVerbose(options.verbose);

  // Step 1: Walk the file tree
  logger.info("\uD83D\uDD0D Scanning directory...");
  const tree = await buildFileTree(absDir, {
    only: options.only,
    ignore: options.ignore,
  });

  const counts = countNodes(tree);
  // Subtract 1 from directories to exclude the root node itself from the count
  const dirCount = counts.directories - 1;
  const fileCount = counts.files;

  // Estimate API calls: 1 per page + 1 for metadata callout + ~1 for code blocks per file + 1 for root callout
  const estimatedFileApiCalls =
    1 + // root page
    1 + // root callout
    dirCount + // directory pages
    fileCount * 3; // file page + metadata + code block(s)

  // Account for git context page if enabled
  let estimatedGitApiCalls = 0;
  const includeGit = !options.skipGitContext;
  if (includeGit) {
    const branchEstimate = Math.min(dirCount > 0 ? 5 : 2, 10);
    estimatedGitApiCalls = branchEstimate * 2 + 8;
  }

  const estimatedApiCalls = estimatedFileApiCalls + estimatedGitApiCalls;

  // Step 2: Print summary
  logger.info(`\n\uD83D\uDCCA Summary:`);
  logger.info(`   Directories: ${dirCount}`);
  logger.info(`   Files:       ${fileCount}`);
  if (includeGit) {
    logger.info(`   Est. API calls: ~${estimatedApiCalls} (~${estimatedFileApiCalls} files + ~${estimatedGitApiCalls} git context)`);
  } else {
    logger.info(`   Est. API calls: ~${estimatedApiCalls}`);
  }

  if (fileCount === 0) {
    logger.warn("\nNo files found after filtering. Nothing to upload.");
    return;
  }

  // Step 3: Dry run - print tree and exit
  if (options.dryRun) {
    logger.info("\n\uD83C\uDF33 File tree (dry run):\n");
    logger.printTree(tree);
    logger.info("\n\u2139\uFE0F  Dry run complete. No API calls were made.");
    return;
  }

  // Step 4: Initialise Notion client
  initNotion(config.notionApiToken, options.concurrency);

  // Start listening for cancellation (q key / ctrl+c)
  logger.startCancellationListener();

  const startTime = Date.now();
  const errors: UploadError[] = [];
  let pagesCreated = 0;
  let filesUploaded = 0;

  let rootPageId = "";

  try {
    // Create root page
    logger.startSpinner(`Creating root page: ${projectName}`);
    rootPageId = await createNotionPage(
      config.notionCodebasesPageId,
      projectName,
      "\uD83D\uDCE6",
    );
    pagesCreated++;

    // Add root callout
    const ignorePatternsDisplay = getIgnorePatternsDisplay(
      absDir,
      options.ignore,
    );

    // Step 4b: Gather git context (before root callout so we can include branch info)
    let gitContext: Awaited<ReturnType<typeof gatherGitContext>> = null;
    if (includeGit) {
      try {
        logger.startSpinner("\uD83D\uDCDD Gathering git context...");
        gitContext = await gatherGitContext(absDir);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Git context failed (continuing with upload): ${message}`);
      }
    }

    await appendRootCallout(
      rootPageId,
      absDir,
      fileCount,
      ignorePatternsDisplay,
      gitContext?.currentBranch,
    );

    // Upload git context page
    if (gitContext) {
      try {
        logger.updateSpinner("\uD83D\uDCDD Uploading git context...");
        await appendGitContextPage(rootPageId, gitContext);
        pagesCreated++;
        logger.debug("\u2713 Git context uploaded");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Git context upload failed (continuing with upload): ${message}`);
      }
    }

    // Step 5: Recursively upload
    await uploadChildren(
      tree.children || [],
      rootPageId,
      absDir,
      {
        errors,
        pagesCreated: () => pagesCreated,
        incrementPages: () => { pagesCreated++; },
        filesUploaded: () => filesUploaded,
        incrementFiles: () => { filesUploaded++; },
        totalFiles: fileCount,
        verbose: options.verbose,
      },
    );

    const elapsedMs = Date.now() - startTime;

    // Step 6: Print summary
    logger.stopCancellationListener();
    logger.printSummary({
      totalPages: pagesCreated,
      totalTime: elapsedMs,
      errors,
      rootPageId,
    });
  } catch (err: unknown) {
    logger.stopCancellationListener();
    if (err instanceof logger.CancelledError) {
      const elapsedMs = Date.now() - startTime;
      logger.printSummary({
        totalPages: pagesCreated,
        totalTime: elapsedMs,
        errors,
        rootPageId,
        wasCancelled: true,
      });
      return;
    }
    logger.failSpinner("Upload failed");
    handleTopLevelError(err);
    throw err;
  }
}

interface UploadContext {
  errors: UploadError[];
  pagesCreated: () => number;
  incrementPages: () => void;
  filesUploaded: () => number;
  incrementFiles: () => void;
  totalFiles: number;
  verbose: boolean;
}

async function uploadChildren(
  children: FileNode[],
  parentPageId: string,
  absRoot: string,
  ctx: UploadContext,
): Promise<void> {
  for (const child of children) {
    logger.throwIfCancelled();
    if (child.type === "directory") {
      await uploadDirectory(child, parentPageId, absRoot, ctx);
    } else {
      await uploadFile(child, parentPageId, absRoot, ctx);
    }
  }
}

async function uploadDirectory(
  node: FileNode,
  parentPageId: string,
  absRoot: string,
  ctx: UploadContext,
): Promise<void> {
  try {
    logger.debug(`Creating directory page: ${node.path}`);
    const pageId = await createDirectoryPage(parentPageId, node.name);
    ctx.incrementPages();

    if (node.children) {
      await uploadChildren(node.children, pageId, absRoot, ctx);
    }
  } catch (err: unknown) {
    if (err instanceof logger.CancelledError) throw err;
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error(`Failed to create directory page: ${node.path} - ${error.message}`);
    ctx.errors.push({ filePath: node.path, error });
  }
}

async function uploadFile(
  node: FileNode,
  parentPageId: string,
  absRoot: string,
  ctx: UploadContext,
): Promise<void> {
  const currentFile = ctx.filesUploaded() + 1;
  logger.printProgress(currentFile, ctx.totalFiles, node.path);

  const absPath = path.join(absRoot, node.path);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Create file page
      const pageId = await createFilePage(
        parentPageId,
        node.name,
        node.language,
      );
      ctx.incrementPages();

      // Read file content
      const { content, truncated } = readFileContent(
        absPath,
        node.size || 0,
      );

      // Append metadata callout
      await appendMetadataBlock(
        pageId,
        node.path,
        formatBytes(node.size || 0),
        truncated,
      );

      // Chunk and append code blocks
      const chunks = chunkFileContent(content);
      await appendCodeBlocks(pageId, chunks, node.language || "plain text");

      ctx.incrementFiles();
      logger.debug(`  \u2713 ${node.path}`);
      return; // Success
    } catch (err: unknown) {
      if (err instanceof logger.CancelledError) throw err;
      const error = err instanceof Error ? err : new Error(String(err));

      if (attempt < MAX_RETRIES) {
        logger.warn(
          `  Retry ${attempt}/${MAX_RETRIES} for ${node.path}: ${error.message}`,
        );
        // Brief pause before retry
        await sleep(1000 * attempt);
        continue;
      }

      // Final attempt failed
      logger.error(`  \u2717 Failed after ${MAX_RETRIES} retries: ${node.path}`);
      ctx.errors.push({ filePath: node.path, error });
    }
  }
}

function handleTopLevelError(err: unknown): void {
  if (isNotionClientError(err)) {
    if (
      err instanceof APIResponseError &&
      err.code === APIErrorCode.Unauthorized
    ) {
      logger.error(
        "\n\u274C Authentication failed. Please check your NOTION_API_TOKEN." +
          "\nMake sure the token is valid and hasn't expired." +
          "\nYou can create a new integration at https://www.notion.so/my-integrations",
      );
      return;
    }

    if (
      err instanceof APIResponseError &&
      err.code === APIErrorCode.ObjectNotFound
    ) {
      logger.error(
        "\n\u274C Parent page not found. Please check your NOTION_CODEBASES_PAGE_ID." +
          "\nMake sure:\n  1. The page ID is correct" +
          "\n  2. Your integration is connected to the page" +
          "\n  3. The integration has the right permissions",
      );
      return;
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  logger.error(`\n\u274C Unexpected error: ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
