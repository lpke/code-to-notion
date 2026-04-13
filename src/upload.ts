import path from "node:path";
import {
  APIResponseError,
  APIErrorCode,
  isNotionClientError,
} from "@notionhq/client";
import type { FileNode, UploadOptions, UploadError, ManifestBuilder, ManifestDiff, ManifestFileEntry, ManifestDirEntry } from "./types.js";
import {
  buildFileTree,
  countNodes,
  readFileContent,
  formatBytes,
  getIgnorePatternsDisplay,
  detectLanguage,
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
  buildRootCalloutText,
  appendGitContextPage,
  populateGitContextPage,
  updateBlock,
  writeManifest,
  findChildPageByTitle,
  deleteBlock,
  readManifest,
  listAllChildren,
  clearPageContent,
} from "./notion.js";
import * as logger from "./logger.js";
import { gatherGitContext } from "./git.js";
import { computeHash, buildLocalFileMap, collectDirPaths, diffManifest, buildManifest } from "./manifest.js";
import { promptExistingAction } from "./prompt.js";
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
    const branchEstimate = Math.min(dirCount > 0 ? 5 : 2, 20);
    const defaultBranchCommits = 50;
    const otherBranchCommits = 20;
    const avgCommitsPerBranch = branchEstimate > 1
      ? Math.round((defaultBranchCommits + (branchEstimate - 1) * otherBranchCommits) / branchEstimate)
      : defaultBranchCommits;
    const perBranchCalls = 2 + avgCommitsPerBranch;
    estimatedGitApiCalls = 3 + (branchEstimate * perBranchCalls);
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

  // Step 3: Dry run without --update/--replace — print tree and exit
  if (options.dryRun && !options.update && !options.replace) {
    logger.info("\n\uD83C\uDF33 File tree (dry run):\n");
    logger.printTree(tree);
    logger.info("\n\u2139\uFE0F  Dry run complete. No API calls were made.");
    return;
  }

  // Step 4: Initialise Notion client
  initNotion(config.notionApiToken, options.concurrency);

  // Step 5: Detect existing project
  // NOTE: findChildPageByTitle returns the first match. If multiple pages share
  // the same name, only the first is detected. Use --name to disambiguate.
  logger.info("\n\uD83D\uDD0E Checking for existing upload...");
  const existingPageId = await findChildPageByTitle(
    config.notionCodebasesPageId,
    projectName,
  );

  if (!existingPageId) {
    logger.info("No existing upload found. Starting fresh upload.");
    // No existing project — fresh upload
    if (options.dryRun) {
      // --dry-run with --update/--replace but nothing exists
      logger.info("\n\uD83C\uDF33 File tree (dry run):\n");
      logger.printTree(tree);
      logger.info("\n\u2139\uFE0F  No existing project found. A fresh upload would be performed.");
      return;
    }
    await freshUpload(projectName, tree, absDir, options, config);
    return;
  }

  // Step 6: Existing project found — determine action
  logger.info(`Found existing '${projectName}' page`);
  let action: 'update' | 'replace' | 'new' | 'cancel';
  if (options.update) {
    action = 'update';
  } else if (options.replace) {
    action = 'replace';
  } else {
    // Interactive prompt (before cancellation listener)
    action = await promptExistingAction(projectName);
  }

  // Step 7: Route based on action
  switch (action) {
    case 'cancel':
      logger.info("Cancelled.");
      return;

    case 'replace':
      if (options.dryRun) {
        logger.info("\n\uD83C\uDF33 File tree (dry run):\n");
        logger.printTree(tree);
        logger.info("\n\u2139\uFE0F  Dry run: existing page would be deleted and a fresh upload performed.");
        return;
      }
      logger.info("\n\uD83D\uDDD1\uFE0F  Replacing existing page...");
      await deleteBlock(existingPageId);
      await freshUpload(projectName, tree, absDir, options, config);
      return;

    case 'new':
      if (options.dryRun) {
        logger.info("\n\uD83C\uDF33 File tree (dry run):\n");
        logger.printTree(tree);
        logger.info("\n\u2139\uFE0F  Dry run: a new page would be created alongside the existing one.");
        return;
      }
      await freshUpload(projectName, tree, absDir, options, config);
      return;

    case 'update':
      if (options.dryRun) {
        await dryRunUpdate(existingPageId, tree, absDir, options);
        return;
      }
      await updateExisting(existingPageId, tree, absDir, options, config);
      return;
  }
}

// ---------------------------------------------------------------------------
// Fresh upload (extracted from original upload function)
// ---------------------------------------------------------------------------

async function freshUpload(
  projectName: string,
  tree: FileNode,
  absDir: string,
  options: UploadOptions,
  config: Config,
): Promise<void> {
  const includeGit = !options.skipGitContext;
  const fileCount = countNodes(tree).files;

  // Start listening for cancellation (q key / ctrl+c)
  logger.startCancellationListener();

  const startTime = Date.now();
  const errors: UploadError[] = [];
  let pagesCreated = 0;
  let filesUploaded = 0;
  const manifestBuilder: ManifestBuilder = { files: {}, directories: {} };

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

    // Gather git context (before root callout so we can include branch info)
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

    const calloutBlockId = await appendRootCallout(
      rootPageId,
      absDir,
      fileCount,
      ignorePatternsDisplay,
      gitContext?.currentBranch,
    );

    // Upload git context page
    let gitContextPageId: string | undefined;
    if (gitContext) {
      try {
        logger.updateSpinner("\uD83D\uDCDD Uploading git context...");
        gitContextPageId = await appendGitContextPage(rootPageId, gitContext);
        pagesCreated++;
        logger.debug("\u2713 Git context uploaded");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Git context upload failed (continuing with upload): ${message}`);
      }
    }

    // Recursively upload
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
        manifestBuilder,
      },
    );

    // Write manifest
    try {
      logger.debug("Writing manifest...");
      const manifest = buildManifest(
        rootPageId,
        manifestBuilder.files,
        manifestBuilder.directories,
        gitContextPageId,
        undefined,
        calloutBlockId,
      );
      await writeManifest(rootPageId, manifest);
      pagesCreated++;
      logger.debug("Manifest written");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to write manifest (upload still succeeded): ${message}`);
    }

    const elapsedMs = Date.now() - startTime;

    // Print summary
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

// ---------------------------------------------------------------------------
// Incremental update
// ---------------------------------------------------------------------------

async function updateExisting(
  existingRootPageId: string,
  tree: FileNode,
  absDir: string,
  options: UploadOptions,
  config: Config,
): Promise<void> {
  const includeGit = !options.skipGitContext;
  const fileCount = countNodes(tree).files;

  // 1. Read manifest
  logger.startSpinner("Reading manifest...");
  const manifestResult = await readManifest(existingRootPageId);

  if (!manifestResult) {
    logger.warn("No manifest found. Cannot perform incremental update. Falling back to replace...");
    await deleteBlock(existingRootPageId);
    const projectName = options.name || path.basename(absDir);
    await freshUpload(projectName, tree, absDir, options, config);
    return;
  }

  const { manifest, manifestPageId } = manifestResult;
  logger.debug(`Manifest loaded: ${Object.keys(manifest.files).length} file(s), ${Object.keys(manifest.directories).length} directory(ies)`);

  // 2. Compute local hashes
  logger.updateSpinner("Computing file hashes...");
  const localFiles = buildLocalFileMap(tree, absDir);
  const localDirs = collectDirPaths(tree);
  logger.debug(`Computing file hashes for ${localFiles.size} file(s)...`);

  // 3. Gather git context (local-only, no API calls)
  let gitContext: Awaited<ReturnType<typeof gatherGitContext>> = null;
  if (includeGit) {
    try {
      gitContext = await gatherGitContext(absDir);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Git context failed (continuing with update): ${message}`);
    }
  }

  // 4. Diff
  const diff = diffManifest(localFiles, localDirs, manifest);
  logger.succeedSpinner("Diff computed");
  logger.logDiffSummary(diff);

  // Verbose: list each changed file
  for (const f of diff.added) logger.debug(`  + ${f}`);
  for (const f of diff.modified) logger.debug(`  ~ ${f}`);
  for (const f of diff.deleted) logger.debug(`  - ${f}`);
  for (const d of diff.addedDirs) logger.debug(`  + ${d}/`);
  for (const d of diff.deletedDirs) logger.debug(`  - ${d}/`);

  // 5. Early exit if nothing changed
  if (
    diff.added.length === 0 &&
    diff.modified.length === 0 &&
    diff.deleted.length === 0 &&
    diff.addedDirs.length === 0 &&
    diff.deletedDirs.length === 0
  ) {
    logger.success("\u2728 Everything is up to date!");
    return;
  }

  // 6. Start cancellation listener + timers
  logger.startCancellationListener();
  const startTime = Date.now();
  const errors: UploadError[] = [];
  let pagesCreated = 0;
  let pagesUpdated = 0;
  let pagesDeleted = 0;

  try {
    // ---------------------------------------------------------------
    // Phase 1: Deletions
    // ---------------------------------------------------------------

    const totalDeletions = diff.deleted.length + diff.deletedDirs.length;
    if (totalDeletions > 0) {
      logger.debug(`Phase 1: Deleting ${diff.deleted.length} removed file(s) and ${diff.deletedDirs.length} removed directory(ies)...`);
    }

    // Delete removed file pages
    for (const filePath of diff.deleted) {
      logger.throwIfCancelled();
      const entry = manifest.files[filePath];
      if (entry) {
        try {
          logger.debug(`Deleting removed: ${filePath}`);
          await deleteBlock(entry.pageId);
          pagesDeleted++;
          logger.debug(`  Deleted: ${filePath}`);
        } catch {
          logger.warn(`Could not delete page for removed file: ${filePath} (may have been manually removed)`);
        }
      }
    }

    // Delete removed directory pages (sorted bottom-up by diffManifest)
    for (const dirPath of diff.deletedDirs) {
      logger.throwIfCancelled();
      const entry = manifest.directories[dirPath];
      if (entry) {
        try {
          logger.debug(`Deleting removed dir: ${dirPath}`);
          await deleteBlock(entry.pageId);
          pagesDeleted++;
          logger.debug(`  Deleted: ${dirPath}/`);
        } catch {
          logger.warn(`Could not delete page for removed dir: ${dirPath} (may have been manually removed)`);
        }
      }
    }

    // ---------------------------------------------------------------
    // Phase 2: Directory creations
    // ---------------------------------------------------------------

    // Build working directory map from surviving manifest directories
    const dirPageIds: Record<string, ManifestDirEntry> = {};
    const deletedDirSet = new Set(diff.deletedDirs);
    for (const [dirPath, entry] of Object.entries(manifest.directories)) {
      if (!deletedDirSet.has(dirPath)) {
        dirPageIds[dirPath] = entry;
      }
    }

    // Create new directories (sorted top-down by diffManifest)
    if (diff.addedDirs.length > 0) {
      logger.debug(`Phase 2: Creating ${diff.addedDirs.length} new directory(ies)...`);
    }
    for (const dirPath of diff.addedDirs) {
      logger.throwIfCancelled();
      const parentDir = path.dirname(dirPath);
      let parentPageId: string;
      if (parentDir === ".") {
        parentPageId = existingRootPageId;
      } else if (dirPageIds[parentDir]) {
        parentPageId = dirPageIds[parentDir].pageId;
      } else {
        logger.error(`Cannot create directory ${dirPath}: parent ${parentDir} not found`);
        continue;
      }

      try {
        logger.debug(`Creating dir: ${dirPath}`);
        const pageId = await createDirectoryPage(parentPageId, path.basename(dirPath));
        dirPageIds[dirPath] = { pageId };
        pagesCreated++;
        logger.debug(`  Created dir: ${dirPath}`);
      } catch (err: unknown) {
        if (err instanceof logger.CancelledError) throw err;
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error(`Failed to create directory page: ${dirPath} - ${error.message}`);
        errors.push({ filePath: dirPath, error });
      }
    }

    // ---------------------------------------------------------------
    // Phase 3: File operations (update modified + create added)
    // ---------------------------------------------------------------

    const totalUploads = diff.modified.length + diff.added.length;
    let uploadCounter = 0;

    // Start with unchanged file entries from the old manifest
    const newFileEntries: Record<string, ManifestFileEntry> = {};
    for (const filePath of diff.unchanged) {
      newFileEntries[filePath] = manifest.files[filePath];
    }

    // Sub-phase 3a: Update modified files in-place
    for (const filePath of diff.modified) {
      logger.throwIfCancelled();
      const localInfo = localFiles.get(filePath);
      if (!localInfo) continue;
      const existingPageId = manifest.files[filePath]?.pageId;
      if (!existingPageId) continue;

      uploadCounter++;
      const label = "Updating";
      logger.printProgress(uploadCounter, totalUploads, `${label} ${filePath}`);

      try {
        const absPath = path.join(absDir, filePath);
        const fileName = path.basename(filePath);
        const language = detectLanguage(fileName);

        // Clear existing page content (metadata callout + code blocks)
        await clearPageContent(existingPageId);

        // Re-append new content
        const { content, truncated } = readFileContent(absPath, localInfo.size);
        await appendMetadataBlock(existingPageId, filePath, formatBytes(localInfo.size), truncated, localInfo.hash);
        const chunks = chunkFileContent(content);
        await appendCodeBlocks(existingPageId, chunks, language || "plain text");

        newFileEntries[filePath] = { pageId: existingPageId, hash: localInfo.hash, size: localInfo.size };
        pagesUpdated++;
        logger.debug(`  \u2713 ${filePath} (updated in-place)`);
      } catch (err: unknown) {
        if (err instanceof logger.CancelledError) throw err;
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error(`  \u2717 Failed: ${filePath} - ${error.message}`);
        errors.push({ filePath, error });
      }
    }

    // Sub-phase 3b: Create new files (added only)
    for (const filePath of diff.added) {
      logger.throwIfCancelled();
      const localInfo = localFiles.get(filePath);
      if (!localInfo) continue;

      const parentDir = path.dirname(filePath);
      let parentPageId: string;
      if (parentDir === ".") {
        parentPageId = existingRootPageId;
      } else if (dirPageIds[parentDir]) {
        parentPageId = dirPageIds[parentDir].pageId;
      } else {
        const error = new Error(`Parent directory ${parentDir} not found`);
        logger.error(`Cannot create file ${filePath}: ${error.message}`);
        errors.push({ filePath, error });
        continue;
      }

      uploadCounter++;
      const label = "Adding";
      logger.printProgress(uploadCounter, totalUploads, `${label} ${filePath}`);

      try {
        const fileName = path.basename(filePath);
        const language = detectLanguage(fileName);
        const pageId = await createFilePage(parentPageId, fileName, language);
        pagesCreated++;

        const absPath = path.join(absDir, filePath);
        const { content, truncated } = readFileContent(absPath, localInfo.size);

        await appendMetadataBlock(
          pageId,
          filePath,
          formatBytes(localInfo.size),
          truncated,
          localInfo.hash,
        );

        const chunks = chunkFileContent(content);
        await appendCodeBlocks(pageId, chunks, language || "plain text");

        newFileEntries[filePath] = { pageId, hash: localInfo.hash, size: localInfo.size };
        logger.debug(`  \u2713 ${filePath}`);
      } catch (err: unknown) {
        if (err instanceof logger.CancelledError) throw err;
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error(`  \u2717 Failed: ${filePath} - ${error.message}`);
        errors.push({ filePath, error });
      }
    }

    // ---------------------------------------------------------------
    // Phase 4: Root callout + Git context
    // ---------------------------------------------------------------

    let newCalloutBlockId = manifest.calloutBlockId;

    try {
      logger.debug("Updating root callout...");
      const ignorePatternsDisplay = getIgnorePatternsDisplay(absDir, options.ignore);
      const calloutText = buildRootCalloutText(
        absDir, localFiles.size, ignorePatternsDisplay, gitContext?.currentBranch
      );

      if (manifest.calloutBlockId) {
        // In-place update via blocks.update (1 API call)
        await updateBlock(manifest.calloutBlockId, {
          callout: {
            rich_text: [{ type: "text", text: { content: calloutText } }],
            icon: { type: "emoji", emoji: "\uD83D\uDCE6" },
            color: "blue_background",
          },
        });
        logger.debug("\u2713 Root callout updated in-place");
      } else {
        // Fallback for old manifests: find callout by listing children
        const rootChildren = await listAllChildren(existingRootPageId);
        const calloutBlock = rootChildren.find((b) => b.type === "callout");
        if (calloutBlock) {
          await updateBlock(calloutBlock.id, {
            callout: {
              rich_text: [{ type: "text", text: { content: calloutText } }],
              icon: { type: "emoji", emoji: "\uD83D\uDCE6" },
              color: "blue_background",
            },
          });
          newCalloutBlockId = calloutBlock.id;
          logger.debug("\u2713 Root callout updated in-place (found via fallback)");
        } else {
          newCalloutBlockId = await appendRootCallout(
            existingRootPageId, absDir, localFiles.size, ignorePatternsDisplay, gitContext?.currentBranch
          );
          logger.debug("\u2713 Root callout created (none found)");
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Root callout update failed (continuing): ${message}`);
    }

    let newGitContextPageId = manifest.gitContextPageId;

    if (includeGit && gitContext) {
      try {
        if (manifest.gitContextPageId) {
          // In-place: clear children and repopulate (page stays at its position)
          logger.updateSpinner("Updating git context page...");
          await clearPageContent(manifest.gitContextPageId);
          await populateGitContextPage(manifest.gitContextPageId, gitContext);
          logger.debug("\u2713 Git context page updated in-place");
          // newGitContextPageId stays the same
        } else {
          // No existing page — create from scratch
          logger.updateSpinner("Creating git context page...");
          newGitContextPageId = await appendGitContextPage(existingRootPageId, gitContext);
          pagesCreated++;
          logger.debug("\u2713 Git context page created");
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Git context update failed (continuing): ${message}`);
      }
    }

    // ---------------------------------------------------------------
    // Phase 5: Write updated manifest
    // ---------------------------------------------------------------

    try {
      logger.debug("Writing updated manifest...");
      const updatedManifest = buildManifest(
        existingRootPageId,
        newFileEntries,
        dirPageIds,
        newGitContextPageId,
        manifest.createdAt,
        newCalloutBlockId,
      );
      await writeManifest(existingRootPageId, updatedManifest, manifestPageId);
      logger.debug("Manifest updated");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to write manifest (update still succeeded): ${message}`);
    }

    // ---------------------------------------------------------------
    // Summary
    // ---------------------------------------------------------------

    const elapsedMs = Date.now() - startTime;
    logger.stopCancellationListener();
    logger.printUpdateSummary({
      pagesCreated,
      pagesUpdated,
      pagesDeleted,
      totalTime: elapsedMs,
      errors,
      diff,
      rootPageId: existingRootPageId,
    });
  } catch (err: unknown) {
    logger.stopCancellationListener();
    if (err instanceof logger.CancelledError) {
      const elapsedMs = Date.now() - startTime;
      logger.printUpdateSummary({
        pagesCreated,
        pagesUpdated,
        pagesDeleted,
        totalTime: elapsedMs,
        errors,
        diff,
        rootPageId: existingRootPageId,
        wasCancelled: true,
      });
      return;
    }
    logger.failSpinner("Update failed");
    handleTopLevelError(err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Dry-run update
// ---------------------------------------------------------------------------

async function dryRunUpdate(
  existingRootPageId: string,
  tree: FileNode,
  absDir: string,
  options: UploadOptions,
): Promise<void> {
  // 1. Read manifest
  logger.startSpinner("Reading manifest...");
  const manifestResult = await readManifest(existingRootPageId);

  if (!manifestResult) {
    logger.warn("No manifest found. An incremental update cannot be previewed.");
    logger.info("\n\u2139\uFE0F  A --replace (full re-upload) would be needed.");
    return;
  }

  const { manifest } = manifestResult;

  // 2. Compute local hashes
  logger.updateSpinner("Computing file hashes...");
  const localFiles = buildLocalFileMap(tree, absDir);
  const localDirs = collectDirPaths(tree);

  // 3. Diff
  const diff = diffManifest(localFiles, localDirs, manifest);
  logger.succeedSpinner("Diff computed");
  logger.logDiffSummary(diff);

  // 4. Early exit if nothing changed
  if (
    diff.added.length === 0 &&
    diff.modified.length === 0 &&
    diff.deleted.length === 0 &&
    diff.addedDirs.length === 0 &&
    diff.deletedDirs.length === 0
  ) {
    logger.success("\u2728 Everything is up to date!");
    return;
  }

  // 5. Verbose file listing
  if (options.verbose) {
    console.log("");
    for (const f of diff.added) {
      console.log(`  + ${f}`);
    }
    for (const f of diff.modified) {
      console.log(`  ~ ${f}`);
    }
    for (const f of diff.deleted) {
      console.log(`  - ${f}`);
    }
    for (const d of diff.addedDirs) {
      console.log(`  + ${d}/`);
    }
    for (const d of diff.deletedDirs) {
      console.log(`  - ${d}/`);
    }
  }

  logger.info("\n\u2139\uFE0F  Dry run complete. No changes were made.");
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface UploadContext {
  errors: UploadError[];
  pagesCreated: () => number;
  incrementPages: () => void;
  filesUploaded: () => number;
  incrementFiles: () => void;
  totalFiles: number;
  verbose: boolean;
  manifestBuilder: ManifestBuilder;
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
    ctx.manifestBuilder.directories[node.path] = { pageId };

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

      // Compute content hash
      const hash = computeHash(content);

      // Append metadata callout
      await appendMetadataBlock(
        pageId,
        node.path,
        formatBytes(node.size || 0),
        truncated,
        hash,
      );

      // Chunk and append code blocks
      const chunks = chunkFileContent(content);
      await appendCodeBlocks(pageId, chunks, node.language || "plain text");

      // Record in manifest
      ctx.manifestBuilder.files[node.path] = { pageId, hash, size: node.size || 0 };

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
