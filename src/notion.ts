import { Client } from "@notionhq/client";
import type { BlockObjectRequest } from "@notionhq/client/build/src/api-endpoints/common.js";
import type { LanguageRequest } from "@notionhq/client/build/src/api-endpoints/common.js";
import { RateLimiter } from "./rate-limiter.js";
import type { GitContext, GitContextBlockMap, Manifest } from "./types.js";
import * as logger from "./logger.js";

let notionClient: Client;
let rateLimiter: RateLimiter;

// --- Date mention helpers ---

/** Create a single-date mention rich text element */
function dateMention(isoDate: string): Record<string, unknown> {
  return {
    type: "mention" as const,
    mention: {
      type: "date" as const,
      date: { start: isoDate, end: null },
    },
  };
}

/** Create a date-range mention rich text element */
function dateRangeMention(startDate: string, endDate: string): Record<string, unknown> {
  return {
    type: "mention" as const,
    mention: {
      type: "date" as const,
      date: { start: startDate, end: endDate },
    },
  };
}

/** Initialise the Notion client and rate limiter */
export function initNotion(apiToken: string, concurrency: number): void {
  notionClient = new Client({
    auth: apiToken,
    // Disable the SDK's built-in retry so we handle it ourselves
    retry: false,
  });
  rateLimiter = new RateLimiter(concurrency);
}

/**
 * Create a "🔀 Git Context" child page under the project root and populate it
 * with structured git metadata blocks.
 */
export async function appendGitContextPage(
  parentPageId: string,
  ctx: GitContext,
): Promise<{ pageId: string; blockMap: GitContextBlockMap }> {
  // Create the child page
  logger.debug("   Creating git context child page...");
  const pageId = await createNotionPage(parentPageId, "Git Context", "\u{1F500}");
  logger.debug("   Git context page created");

  const blockMap = await populateGitContextPage(pageId, ctx);

  return { pageId, blockMap };
}

/**
 * Build the summary callout rich text for the git context page.
 * Uses date mentions for repo age dates.
 */
function buildGitSummaryRichText(ctx: GitContext): Array<Record<string, unknown>> {
  const primaryRemote = ctx.remotes.length > 0 ? ctx.remotes[0].url : "(none)";
  const branchNote = ctx.branchLimitApplied
    ? ` (showing ${ctx.branches.length} of ${ctx.totalBranchCount})`
    : "";
  const tagNote = ctx.totalTagCount > ctx.tags.length
    ? ` (showing ${ctx.tags.length} of ${ctx.totalTagCount})`
    : "";
  return [
    { type: "text", text: { content: `Remote: ${primaryRemote}\nCurrent branch: ${ctx.currentBranch}\nDefault branch: ${ctx.defaultBranch}\nTotal commits: ${ctx.totalCommits}\nRepo age: ` } },
    dateMention(ctx.repoAge),
    { type: "text", text: { content: " \u2192 " } },
    dateMention(ctx.lastCommitDate),
    { type: "text", text: { content: `\nBranches: ${ctx.totalBranchCount}${branchNote}\nTags: ${ctx.totalTagCount}${tagNote}` } },
  ];
}

/**
 * Build the heading text for a branch toggle.
 * Returns a rich text array with a date mention for the last commit date.
 */
function buildBranchToggleRichText(branch: GitContext["branches"][0]): Array<Record<string, unknown>> {
  const indicator = branch.isCurrentBranch ? " \u2B05" : "";
  const commitNote = branch.totalCommitCount > branch.commits.length
    ? ` \u2014 showing ${branch.commits.length} of ${branch.totalCommitCount} commits`
    : "";
  return [
    { type: "text", text: { content: `${branch.name} (last commit: ` } },
    dateMention(branch.lastCommitDate),
    { type: "text", text: { content: `)${indicator}${commitNote}` } },
  ];
}

/**
 * Populate a branch toggle with commit children.
 * Commits are rendered in newest-first order (natural git log order).
 * A divider "anchor" block is inserted as the first child on fresh uploads;
 * during incremental updates, new commits are inserted after the existing
 * anchor so they appear above previously uploaded commits.
 *
 * @param afterBlockId - If provided, insert commits after this anchor block
 *   (incremental update). If omitted, create a new anchor (fresh upload).
 * @returns The anchor block ID when a new anchor was created (fresh upload),
 *   or undefined when afterBlockId was provided (incremental update).
 */
async function populateBranchCommits(
  toggleBlockId: string,
  branch: GitContext["branches"][0],
  afterBlockId?: string,
): Promise<string | undefined> {
  if (branch.commits.length === 0) return undefined;

  const dedupedCommits = branch.commits.filter((c) => c.deduplicated);
  if (dedupedCommits.length > 0) {
    logger.debug(`         ${dedupedCommits.length} commit(s) de-duplicated (shown as one-liners)`);
  }

  // Keep newest-first order from git (no reversal)
  const orderedCommits = branch.commits;

  // Build children: full commits as toggles, deduplicated as plain text paragraphs
  const commitChildren: BlockObjectRequest[] = [];
  for (const commit of orderedCommits) {
    const lineText = `${commit.shortHash} | ${formatDate(commit.date)} | ${commit.author} | ${commit.subject}`;

    if (commit.deduplicated) {
      commitChildren.push({
        type: "paragraph",
        paragraph: {
          rich_text: [
            { type: "text", text: { content: lineText }, annotations: { code: true, bold: false, italic: false, strikethrough: false, underline: false, color: "default" } },
            { type: "text", text: { content: "  \u2196 see earlier branch" }, annotations: { italic: true, bold: false, code: false, strikethrough: false, underline: false, color: "default" } },
          ],
          color: "default",
        },
      } as BlockObjectRequest);
    } else {
      const innerChildren: BlockObjectRequest[] = [];
      if (commit.body) {
        innerChildren.push(codeBlock(commit.body));
      }
      if (commit.diffstat) {
        innerChildren.push(codeBlock(commit.diffstat));
      }

      commitChildren.push({
        type: "toggle",
        toggle: {
          rich_text: [{ type: "text", text: { content: lineText }, annotations: { code: true, bold: false, italic: false, strikethrough: false, underline: false, color: "default" } }],
          color: "default",
          ...(innerChildren.length > 0 ? { children: innerChildren } : {}),
        },
      } as BlockObjectRequest);
    }
  }

  // --- Fresh upload path: create anchor (divider) as first child ---
  let createdAnchorId: string | undefined;
  if (!afterBlockId) {
    const anchorResponse = await rateLimiter.schedule(() =>
      notionClient.blocks.children.append({
        block_id: toggleBlockId,
        children: [{ type: "divider", divider: {} } as BlockObjectRequest],
      }),
    );
    createdAnchorId = anchorResponse.results[0].id;
  }

  // --- Append commits using `after` for positional insertion ---
  // Fresh uploads: insert after the newly created anchor
  // Incremental updates: insert after the provided afterBlockId
  let currentAfterId = afterBlockId || createdAnchorId;

  const commitBatches = Math.ceil(commitChildren.length / 100);
  for (let j = 0; j < commitChildren.length; j += 100) {
    const batch = commitChildren.slice(j, j + 100);
    if (commitBatches > 1) {
      logger.debug(`         Sending commit batch ${Math.floor(j / 100) + 1}/${commitBatches} (${batch.length} commits)...`);
    }
    const response = await rateLimiter.schedule(() =>
      notionClient.blocks.children.append({
        block_id: toggleBlockId,
        children: batch,
        ...(currentAfterId ? { after: currentAfterId } : {}),
      }),
    );
    // Chain: next batch goes after the last block of this batch
    const results = response.results;
    if (results.length > 0) {
      currentAfterId = (results[results.length - 1] as { id: string }).id;
    }
  }

  return createdAnchorId;
}

/**
 * Populate an existing git context page with structured git metadata blocks.
 * Returns a GitContextBlockMap for incremental updates.
 */
export async function populateGitContextPage(
  pageId: string,
  ctx: GitContext,
): Promise<GitContextBlockMap> {

  // --- Build all top-level blocks ---
  const blocks: BlockObjectRequest[] = [];

  // 1. Summary callout
  logger.info("   Writing summary callout...");
  const summaryRichText = buildGitSummaryRichText(ctx);
  blocks.push({
    type: "callout",
    callout: {
      rich_text: summaryRichText as any,
      icon: { type: "emoji", emoji: "\u{1F500}" },
      color: "blue_background",
    },
  });

  // 2. Recent Activity heading (h1, smart start date)
  logger.info("   Writing recent activity...");
  const smartStartDate = ctx.recentActivity.oldestActivityDate
    && ctx.recentActivity.oldestActivityDate > ctx.dateBoundaries.recentActivityStart
    ? ctx.recentActivity.oldestActivityDate
    : ctx.dateBoundaries.recentActivityStart;
  blocks.push(heading1WithDateRange("Recent Activity", smartStartDate, ctx.dateBoundaries.recentActivityEnd));

  // Recent Commits sub-section (h2)
  blocks.push(heading2("Recent Commits"));

  if (ctx.recentActivity.commitsLast14Days.length > 0) {
    const recentLines = ctx.recentActivity.commitsLast14Days.map((c) => {
      const branchTag = c.branches ? ` [${c.branches}]` : "";
      return `${c.shortHash} | ${formatDate(c.date)} | ${c.author} | ${c.subject}${branchTag}`;
    });
    blocks.push(codeBlock(recentLines.join("\n")));
  } else {
    blocks.push(paragraph("No commits in the last 14 days."));
  }

  // Recently Changed Files (h2)
  if (ctx.recentActivity.hotFiles.length > 0) {
    logger.info("   Writing recently changed files...");
    blocks.push(heading2("Recently Changed Files"));
    const hotLines = ctx.recentActivity.hotFiles.map(
      (f) => `${f.count} changes | ${f.file}`,
    );
    blocks.push(codeBlock(hotLines.join("\n")));
  }

  // Recent Contributors (h2)
  if (ctx.recentActivity.activeContributors.length > 0) {
    logger.info("   Writing contributors...");
    blocks.push(heading2("Recent Contributors"));
    const contribLines = ctx.recentActivity.activeContributors.map(
      (c) => `${c.commits} commits | ${c.name}`,
    );
    blocks.push(codeBlock(contribLines.join("\n")));
  }

  // 4. Branches heading (h1)
  logger.info(`   Writing branch history (${ctx.branches.length} branches)...`);
  blocks.push(heading1("Branches"));

  // Build toggleable heading blocks for each branch (h2 with date mention)
  const branchToggleBlocks: BlockObjectRequest[] = [];
  for (const branch of ctx.branches) {
    branchToggleBlocks.push({
      type: "heading_2",
      heading_2: {
        rich_text: buildBranchToggleRichText(branch) as any,
        is_toggleable: true,
        color: "default",
      },
    } as BlockObjectRequest);
  }

  // 5. Tags heading (only if tags exist)
  const tagBlocks: BlockObjectRequest[] = [];
  if (ctx.tags.length > 0) {
    logger.info("   Writing tags...");
    const tagHeader = ctx.totalTagCount > ctx.tags.length
      ? `Tags (showing ${ctx.tags.length} of ${ctx.totalTagCount})`
      : "Tags";
    tagBlocks.push(heading2(tagHeader));
    const tagLines = ctx.tags.map(
      (t) => `${t.name} | ${formatDate(t.date)} | ${t.subject}`,
    );
    tagBlocks.push(codeBlock(tagLines.join("\n")));
  }

  // --- Append all top-level blocks in batches ---
  const allTopLevel = [...blocks, ...branchToggleBlocks, ...tagBlocks];
  logger.debug(`   Appending ${allTopLevel.length} top-level blocks (${Math.ceil(allTopLevel.length / 100)} batch(es))...`);

  for (let i = 0; i < allTopLevel.length; i += 100) {
    const batch = allTopLevel.slice(i, i + 100);
    const batchNum = Math.floor(i / 100) + 1;
    const totalBatches = Math.ceil(allTopLevel.length / 100);
    if (totalBatches > 1) {
      logger.debug(`      Sending top-level block batch ${batchNum}/${totalBatches} (${batch.length} blocks)...`);
    }
    await rateLimiter.schedule(() =>
      notionClient.blocks.children.append({
        block_id: pageId,
        children: batch,
      }),
    );
  }

  // --- Fetch all page children to build the block map ---
  logger.debug("   Fetching page children to resolve block IDs...");
  const allChildren = await listAllChildren(pageId);

  // --- Build the GitContextBlockMap by walking children in order ---
  const blockMap: GitContextBlockMap = {
    calloutId: "",
    recentActivityHeadingId: "",
    recentActivityCodeId: "",
    branchesHeadingId: "",
    branches: {},
  };

  let childIdx = 0;
  const next = () => allChildren[childIdx++];

  // 1. Callout
  const calloutChild = next();
  blockMap.calloutId = calloutChild.id;

  // 2. Recent Activity h1 heading
  const recentHeading = next();
  blockMap.recentActivityHeadingId = recentHeading.id;

  // 3. Recent Commits h2 heading
  const recentCommitsHeading = next();
  blockMap.recentCommitsHeadingId = recentCommitsHeading.id;

  // 4. Recent Activity code/paragraph
  const recentCode = next();
  blockMap.recentActivityCodeId = recentCode.id;

  // 5-8. Optional sections: hot files, contributors
  // These are non-toggleable heading_2 + code pairs
  while (childIdx < allChildren.length) {
    const peek = allChildren[childIdx];
    if (peek.type === "heading_2") {
      const h2 = peek.heading_2 as { is_toggleable?: boolean; rich_text?: Array<{ plain_text?: string }> };
      if (h2?.is_toggleable) break; // Branch toggle — stop
      const text = h2?.rich_text?.[0]?.plain_text || "";
      if (text.startsWith("Recently Changed Files")) {
        const block = next();
        const codeChild = next();
        blockMap.hotFilesHeadingId = block.id;
        blockMap.hotFilesCodeId = codeChild.id;
      } else if (text.startsWith("Recent Contributors")) {
        const block = next();
        const codeChild = next();
        blockMap.contributorsHeadingId = block.id;
        blockMap.contributorsCodeId = codeChild.id;
      } else {
        break; // Unknown h2, could be Branches or Tags
      }
    } else if (peek.type === "heading_1") {
      break; // Branches h1 heading — stop
    } else {
      childIdx++; // skip unexpected
    }
  }

  // 9. Branches h1 heading
  if (childIdx < allChildren.length && allChildren[childIdx].type === "heading_1") {
    blockMap.branchesHeadingId = next().id;
  }

  // 10. Branch toggles (heading_2 with is_toggleable)
  const toggleBlocks: Array<{ id: string }> = [];
  while (childIdx < allChildren.length) {
    const peek = allChildren[childIdx];
    if (peek.type === "heading_2") {
      const h2 = peek.heading_2 as { is_toggleable?: boolean };
      if (h2?.is_toggleable) {
        toggleBlocks.push(next());
        continue;
      }
    }
    break; // tags section or end
  }

  // 11-12. Optional tags
  if (childIdx < allChildren.length && allChildren[childIdx].type === "heading_2") {
    blockMap.tagsHeadingId = next().id;
    if (childIdx < allChildren.length) {
      blockMap.tagsCodeId = next().id;
    }
  }

  // --- Populate branch commits and record in block map ---
  logger.debug(`   Uploading commit history for ${ctx.branches.length} branch(es)...`);
  for (let i = 0; i < ctx.branches.length && i < toggleBlocks.length; i++) {
    const branch = ctx.branches[i];
    const toggleBlockId = toggleBlocks[i].id;
    let anchorId: string | undefined;

    if (branch.commits.length === 0) {
      logger.debug(`      [${i + 1}/${ctx.branches.length}] ${branch.name}: no commits, skipping`);
    } else {
      logger.debug(`      [${i + 1}/${ctx.branches.length}] ${branch.name}: ${branch.commits.length} commit(s)...`);
      anchorId = await populateBranchCommits(toggleBlockId, branch);
    }

    blockMap.branches[branch.name] = {
      toggleId: toggleBlockId,
      lastCommitHash: branch.lastCommitHash,
      anchorBlockId: anchorId || "",
    };
  }

  return blockMap;
}

/**
 * Incrementally update the git context page using section-level diffing.
 * Returns the updated GitContextBlockMap.
 */
export async function updateGitContextPage(
  pageId: string,
  ctx: GitContext,
  existingBlockMap: GitContextBlockMap,
): Promise<GitContextBlockMap> {
  const newBlockMap: GitContextBlockMap = {
    calloutId: existingBlockMap.calloutId,
    recentActivityHeadingId: existingBlockMap.recentActivityHeadingId,
    recentActivityCodeId: existingBlockMap.recentActivityCodeId,
    branchesHeadingId: existingBlockMap.branchesHeadingId,
    branches: {},
  };

  // Step 1: Update summary callout
  logger.info("   Updating summary callout...");
  const summaryRichText = buildGitSummaryRichText(ctx);
  await updateBlock(existingBlockMap.calloutId, {
    callout: {
      rich_text: summaryRichText as any,
      icon: { type: "emoji", emoji: "\u{1F500}" },
      color: "blue_background",
    },
  });

  // Step 2: Update recent activity section
  logger.info("   Updating recent activity...");
  const smartStartDate = ctx.recentActivity.oldestActivityDate
    && ctx.recentActivity.oldestActivityDate > ctx.dateBoundaries.recentActivityStart
    ? ctx.recentActivity.oldestActivityDate
    : ctx.dateBoundaries.recentActivityStart;

  await updateBlock(existingBlockMap.recentActivityHeadingId, {
    heading_1: {
      rich_text: [
        { type: "text", text: { content: "Recent Activity (" } },
        dateRangeMention(smartStartDate, ctx.dateBoundaries.recentActivityEnd),
        { type: "text", text: { content: ")" } },
      ] as any,
      color: "default",
    },
  });

  // Update or create Recent Commits h2 heading
  if (existingBlockMap.recentCommitsHeadingId) {
    await updateBlock(existingBlockMap.recentCommitsHeadingId, {
      heading_2: {
        rich_text: [{ type: "text", text: { content: "Recent Commits" } }],
        color: "default",
      },
    });
    newBlockMap.recentCommitsHeadingId = existingBlockMap.recentCommitsHeadingId;
  } else {
    // Migration: create new h2 heading after the recent activity heading
    const response = await rateLimiter.schedule(() =>
      notionClient.blocks.children.append({
        block_id: pageId,
        children: [heading2("Recent Commits")],
        after: existingBlockMap.recentActivityHeadingId,
      }),
    );
    newBlockMap.recentCommitsHeadingId = response.results[0].id;
  }

  if (ctx.recentActivity.commitsLast14Days.length > 0) {
    const recentLines = ctx.recentActivity.commitsLast14Days.map((c) => {
      const branchTag = c.branches ? ` [${c.branches}]` : "";
      return `${c.shortHash} | ${formatDate(c.date)} | ${c.author} | ${c.subject}${branchTag}`;
    });
    await updateBlock(existingBlockMap.recentActivityCodeId, {
      code: { rich_text: chunkedRichText(recentLines.join("\n")), language: "plain text" },
    });
  } else {
    await updateBlock(existingBlockMap.recentActivityCodeId, {
      paragraph: { rich_text: [{ type: "text", text: { content: "No commits in the last 14 days." } }] },
    });
  }

  // Step 3: Update optional sections (hot files, contributors)
  const updateOptionalSection = async (
    existingHeadingId: string | undefined,
    existingCodeId: string | undefined,
    hasData: boolean,
    headingText: string,
    codeContent: string,
    afterBlockId: string,
  ): Promise<{ headingId?: string; codeId?: string }> => {
    if (existingHeadingId && existingCodeId && hasData) {
      // Update both
      await updateBlock(existingHeadingId, {
        heading_2: { rich_text: [{ type: "text", text: { content: headingText } }], color: "default" },
      });
      await updateBlock(existingCodeId, {
        code: { rich_text: chunkedRichText(codeContent), language: "plain text" },
      });
      return { headingId: existingHeadingId, codeId: existingCodeId };
    } else if (existingHeadingId && existingCodeId && !hasData) {
      // Delete both
      await deleteBlock(existingCodeId);
      await deleteBlock(existingHeadingId);
      return {};
    } else if (!existingHeadingId && hasData) {
      // Create new heading + code after afterBlockId
      const response = await rateLimiter.schedule(() =>
        notionClient.blocks.children.append({
          block_id: pageId,
          children: [heading2(headingText), codeBlock(codeContent)],
          after: afterBlockId,
        }),
      );
      return {
        headingId: response.results[0].id,
        codeId: response.results[1].id,
      };
    }
    return {};
  };

  // Track the "last block before branches" for insert-after positioning
  let lastSectionBlockId = existingBlockMap.recentActivityCodeId;

  // Hot files
  const hasHotFiles = ctx.recentActivity.hotFiles.length > 0;
  const hotFilesContent = hasHotFiles
    ? ctx.recentActivity.hotFiles.map((f) => `${f.count} changes | ${f.file}`).join("\n")
    : "";
  if (existingBlockMap.hotFilesHeadingId && hasHotFiles) {
    logger.info("   Updating recently changed files...");
  } else if (existingBlockMap.hotFilesHeadingId && !hasHotFiles) {
    logger.info("   Removing recently changed files (no data)...");
  } else if (!existingBlockMap.hotFilesHeadingId && hasHotFiles) {
    logger.info("   Adding recently changed files...");
  }
  const hotResult = await updateOptionalSection(
    existingBlockMap.hotFilesHeadingId,
    existingBlockMap.hotFilesCodeId,
    hasHotFiles,
    "Recently Changed Files",
    hotFilesContent,
    lastSectionBlockId,
  );
  newBlockMap.hotFilesHeadingId = hotResult.headingId;
  newBlockMap.hotFilesCodeId = hotResult.codeId;
  if (hotResult.codeId) lastSectionBlockId = hotResult.codeId;

  // Contributors
  const hasContribs = ctx.recentActivity.activeContributors.length > 0;
  const contribContent = hasContribs
    ? ctx.recentActivity.activeContributors.map((c) => `${c.commits} commits | ${c.name}`).join("\n")
    : "";
  if (existingBlockMap.contributorsHeadingId && hasContribs) {
    logger.info("   Updating contributors...");
  } else if (existingBlockMap.contributorsHeadingId && !hasContribs) {
    logger.info("   Removing contributors (no data)...");
  } else if (!existingBlockMap.contributorsHeadingId && hasContribs) {
    logger.info("   Adding contributors...");
  }
  const contribResult = await updateOptionalSection(
    existingBlockMap.contributorsHeadingId,
    existingBlockMap.contributorsCodeId,
    hasContribs,
    "Recent Contributors",
    contribContent,
    lastSectionBlockId,
  );
  newBlockMap.contributorsHeadingId = contribResult.headingId;
  newBlockMap.contributorsCodeId = contribResult.codeId;
  if (contribResult.codeId) lastSectionBlockId = contribResult.codeId;

  // Clean up stale diffstat blocks from old manifests (migration)
  if ((existingBlockMap as any).diffstatHeadingId) {
    try {
      if ((existingBlockMap as any).diffstatCodeId) {
        await deleteBlock((existingBlockMap as any).diffstatCodeId);
      }
      await deleteBlock((existingBlockMap as any).diffstatHeadingId);
      logger.debug("      Cleaned up stale diffstat blocks");
    } catch {
      logger.debug("      Could not clean up stale diffstat blocks (may already be removed)");
    }
  }

  // Step 4: Update branches
  logger.info(`   Updating branches (${ctx.branches.length})...`);
  const existingBranchNames = new Set(Object.keys(existingBlockMap.branches));
  const currentBranchNames = new Set(ctx.branches.map((b) => b.name));

  // Update or skip existing branches
  for (const [branchName, entry] of Object.entries(existingBlockMap.branches)) {
    if (!currentBranchNames.has(branchName)) {
      // Branch deleted — remove toggle
      logger.debug(`      ${branchName}: deleted, removing`);
      await deleteBlock(entry.toggleId);
      continue;
    }

    const branch = ctx.branches.find((b) => b.name === branchName)!;
    if (entry.lastCommitHash === branch.lastCommitHash) {
      // Unchanged — update heading to new format (h2 with date mention) but skip commits
      logger.debug(`      ${branchName}: unchanged, skipping`);
      await updateBlock(entry.toggleId, {
        heading_2: {
          rich_text: buildBranchToggleRichText(branch) as any,
          is_toggleable: true,
          color: "default",
        },
      });
      newBlockMap.branches[branchName] = entry;
    } else {
      // Changed — incremental append
      logger.debug(`      ${branchName}: changed, updating...`);

      // Update heading to new format (h2 with date mention)
      await updateBlock(entry.toggleId, {
        heading_2: {
          rich_text: buildBranchToggleRichText(branch) as any,
          is_toggleable: true,
          color: "default",
        },
      });

      // Migration: old manifests lack anchorBlockId — do a full rewrite to establish one
      if (!entry.anchorBlockId) {
        logger.debug(`      ${branchName}: no anchor (old manifest), full rewrite`);
        const toggleChildren = await listAllChildren(entry.toggleId);
        for (const child of toggleChildren) {
          await deleteBlock(child.id);
        }
        const newAnchorId = await populateBranchCommits(entry.toggleId, branch);
        newBlockMap.branches[branchName] = {
          toggleId: entry.toggleId,
          lastCommitHash: branch.lastCommitHash,
          anchorBlockId: newAnchorId || "",
        };
        continue;
      }

      // Find where the new commits start
      const lastKnownHash = entry.lastCommitHash;
      const newCommitIndex = branch.commits.findIndex(
        (c) => c.shortHash === lastKnownHash || c.hash === lastKnownHash,
      );

      if (newCommitIndex === -1) {
        // lastCommitHash not found — force push or rebase, fall back to full rewrite
        logger.debug(`      ${branchName}: force push/rebase detected, full rewrite (${branch.commits.length} commits)`);
        const toggleChildren = await listAllChildren(entry.toggleId);
        for (const child of toggleChildren) {
          await deleteBlock(child.id);
        }
        // No afterBlockId — fresh populate creates a new anchor
        const newAnchorId = await populateBranchCommits(entry.toggleId, branch);
        newBlockMap.branches[branchName] = {
          toggleId: entry.toggleId,
          lastCommitHash: branch.lastCommitHash,
          anchorBlockId: newAnchorId || "",
        };
      } else {
        // Commits before newCommitIndex are new (git log is newest-first)
        const newCommits = branch.commits.slice(0, newCommitIndex);

        if (newCommits.length === 0) {
          // No new commits despite hash mismatch (shouldn't happen)
          newBlockMap.branches[branchName] = entry;
        } else {
          // newCommits are already newest-first from the git log slice.
          // Pass entry.anchorBlockId so they're inserted after the anchor (before existing commits).
          logger.debug(`      ${branchName}: ${newCommits.length} new commit(s), appending`);
          const tempBranch = { ...branch, commits: newCommits };
          await populateBranchCommits(entry.toggleId, tempBranch, entry.anchorBlockId);

          newBlockMap.branches[branchName] = {
            toggleId: entry.toggleId,
            lastCommitHash: branch.lastCommitHash,
            anchorBlockId: entry.anchorBlockId,
          };
        }
      }
    }
  }

  // Add new branches
  for (const branch of ctx.branches) {
    if (existingBranchNames.has(branch.name)) continue;
    logger.debug(`      ${branch.name}: new branch, creating (${branch.commits.length} commits)`);

    const response = await rateLimiter.schedule(() =>
      notionClient.blocks.children.append({
        block_id: pageId,
        children: [
          {
            type: "heading_2",
            heading_2: {
              rich_text: buildBranchToggleRichText(branch) as any,
              is_toggleable: true,
              color: "default",
            },
          } as BlockObjectRequest,
        ],
        after: existingBlockMap.branchesHeadingId,
      }),
    );
    const newToggleId = response.results[0].id;
    const newAnchorId = await populateBranchCommits(newToggleId, branch);
    newBlockMap.branches[branch.name] = {
      toggleId: newToggleId,
      lastCommitHash: branch.lastCommitHash,
      anchorBlockId: newAnchorId || "",
    };
  }

  // Step 5: Update tags
  const hasNewTags = ctx.tags.length > 0;
  const tagHeader = ctx.totalTagCount > ctx.tags.length
    ? `Tags (showing ${ctx.tags.length} of ${ctx.totalTagCount})`
    : "Tags";
  const tagContent = ctx.tags.map((t) => `${t.name} | ${formatDate(t.date)} | ${t.subject}`).join("\n");

  if (existingBlockMap.tagsHeadingId && existingBlockMap.tagsCodeId && hasNewTags) {
    logger.info("   Updating tags...");
    await updateBlock(existingBlockMap.tagsHeadingId, {
      heading_2: { rich_text: [{ type: "text", text: { content: tagHeader } }], color: "default" },
    });
    await updateBlock(existingBlockMap.tagsCodeId, {
      code: { rich_text: chunkedRichText(tagContent), language: "plain text" },
    });
    newBlockMap.tagsHeadingId = existingBlockMap.tagsHeadingId;
    newBlockMap.tagsCodeId = existingBlockMap.tagsCodeId;
  } else if (existingBlockMap.tagsHeadingId && existingBlockMap.tagsCodeId && !hasNewTags) {
    logger.info("   Removing tags...");
    await deleteBlock(existingBlockMap.tagsCodeId);
    await deleteBlock(existingBlockMap.tagsHeadingId);
  } else if (!existingBlockMap.tagsHeadingId && hasNewTags) {
    logger.info("   Adding tags...");
    // Append at end of page
    const response = await rateLimiter.schedule(() =>
      notionClient.blocks.children.append({
        block_id: pageId,
        children: [heading2(tagHeader), codeBlock(tagContent)],
      }),
    );
    newBlockMap.tagsHeadingId = response.results[0].id;
    newBlockMap.tagsCodeId = response.results[1].id;
  }

  return newBlockMap;
}

/** Format an ISO date string to a shorter human-readable format */
function formatDate(isoDate: string): string {
  if (!isoDate || isoDate === "unknown") return "unknown";
  try {
    const d = new Date(isoDate);
    return d.toISOString().slice(0, 10);
  } catch {
    return isoDate;
  }
}

/** Create a heading_1 block */
function heading1(text: string): BlockObjectRequest {
  return {
    type: "heading_1",
    heading_1: {
      rich_text: [{ type: "text", text: { content: text } }],
      color: "default",
    },
  };
}

/** Create a heading_1 block with a date range mention */
function heading1WithDateRange(prefix: string, startDate: string, endDate: string): BlockObjectRequest {
  return {
    type: "heading_1",
    heading_1: {
      rich_text: [
        { type: "text", text: { content: `${prefix} (` } },
        dateRangeMention(startDate, endDate) as any,
        { type: "text", text: { content: ")" } },
      ],
      color: "default",
    },
  };
}

/** Create a heading_2 block */
function heading2(text: string): BlockObjectRequest {
  return {
    type: "heading_2",
    heading_2: {
      rich_text: [{ type: "text", text: { content: text } }],
      color: "default",
    },
  };
}

/** Create a heading_2 block with a date range mention */
function heading2WithDateRange(prefix: string, startDate: string, endDate: string): BlockObjectRequest {
  return {
    type: "heading_2",
    heading_2: {
      rich_text: [
        { type: "text", text: { content: `${prefix} (` } },
        dateRangeMention(startDate, endDate) as any,
        { type: "text", text: { content: ")" } },
      ],
      color: "default",
    },
  };
}

/** Create a code block (plain text) */
function codeBlock(content: string): BlockObjectRequest {
  return {
    type: "code",
    code: {
      rich_text: chunkedRichText(content),
      language: "plain text",
    },
  };
}

/** Split content into <=2000-char rich text elements for the Notion API */
function chunkedRichText(content: string): Array<{ type: "text"; text: { content: string } }> {
  const MAX_CHUNK = 2000;
  const richText: Array<{ type: "text"; text: { content: string } }> = [];
  let remaining = content;
  while (remaining.length > 0) {
    richText.push({
      type: "text",
      text: { content: remaining.slice(0, MAX_CHUNK) },
    });
    remaining = remaining.slice(MAX_CHUNK);
  }
  if (richText.length === 0) {
    richText.push({ type: "text", text: { content: "" } });
  }
  return richText;
}

/** Create a paragraph block */
function paragraph(text: string): BlockObjectRequest {
  return {
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: text } }],
    },
  };
}

/** Icon map for file types */
const FILE_ICON_MAP: Record<string, string> = {
  // Config files
  json: "\u2699\uFE0F",
  toml: "\u2699\uFE0F",
  yaml: "\u2699\uFE0F",
  // Docs
  markdown: "\uD83D\uDCDD",
  // Styles
  css: "\uD83C\uDFA8",
  scss: "\uD83C\uDFA8",
  sass: "\uD83C\uDFA8",
  less: "\uD83C\uDFA8",
  // Shell/config
  bash: "\uD83D\uDCDF",
  docker: "\uD83D\uDC33",
  makefile: "\uD83D\uDD27",
  // Data
  sql: "\uD83D\uDDC4\uFE0F",
  graphql: "\uD83D\uDD37",
};

/** Get a sensible emoji icon for a file based on its language */
function getFileIcon(language?: string): string {
  if (language && FILE_ICON_MAP[language]) {
    return FILE_ICON_MAP[language];
  }
  return "\uD83D\uDCC4"; // Default: page facing up
}

/**
 * Create a child page under a parent with the given title and icon emoji.
 * Returns the new page ID.
 */
export async function createNotionPage(
  parentId: string,
  title: string,
  icon?: string,
): Promise<string> {
  const response = await rateLimiter.schedule(() =>
    notionClient.pages.create({
      parent: { page_id: parentId },
      icon: icon ? { type: "emoji", emoji: icon } : undefined,
      properties: {
        title: {
          type: "title",
          title: [{ type: "text", text: { content: title } }],
        },
      },
    }),
  );

  return response.id;
}

/**
 * Create a child page under a parent.
 * Notion API does not support creating child_page blocks via
 * blocks.children.append — child_page is a read-only block type.
 * There is also no block move/reorder API. pages.create always
 * appends to the end of the parent.
 */
export async function createChildPageAtPosition(
  parentId: string,
  title: string,
  icon?: string,
): Promise<string> {
  return createNotionPage(parentId, title, icon);
}

/**
 * Create a child page for a directory.
 */
export async function createDirectoryPage(
  parentId: string,
  dirName: string,
): Promise<string> {
  return createChildPageAtPosition(parentId, dirName, "\uD83D\uDCC1");
}

/**
 * Create a child page for a file.
 */
export async function createFilePage(
  parentId: string,
  fileName: string,
  language?: string,
): Promise<string> {
  const icon = getFileIcon(language);
  return createChildPageAtPosition(parentId, fileName, icon);
}

/**
 * Append code blocks to a page.
 * Each element of `chunks` is an array of strings (<=2000 chars each)
 * representing one code block.
 */
export async function appendCodeBlocks(
  pageId: string,
  chunks: string[][],
  language: LanguageRequest,
): Promise<void> {
  // Notion API allows max 100 blocks per append call, but we typically
  // have just a few code blocks per file
  const blocks: BlockObjectRequest[] = chunks.map((richTextChunks) => ({
    type: "code" as const,
    code: {
      rich_text: richTextChunks.map((text) => ({
        type: "text" as const,
        text: { content: text },
      })),
      language,
    },
  }));

  // Append in batches of 100 (Notion limit)
  for (let i = 0; i < blocks.length; i += 100) {
    const batch = blocks.slice(i, i + 100);
    await rateLimiter.schedule(() =>
      notionClient.blocks.children.append({
        block_id: pageId,
        children: batch,
      }),
    );
  }
}

/**
 * Append a metadata callout block at the top of a file page.
 */
export async function appendMetadataBlock(
  pageId: string,
  filePath: string,
  fileSize: string,
  truncated: boolean,
  hash?: string,
): Promise<void> {
  const richText: Array<Record<string, unknown>> = [
    { type: "text", text: { content: `\uD83D\uDCC2 ${filePath}\n\uD83D\uDCCA ${fileSize}` } },
  ];
  if (hash) {
    richText.push({ type: "text", text: { content: `\n\uD83D\uDD11 ${hash}` } });
  }
  richText.push({ type: "text", text: { content: "\n\uD83D\uDD52 " } });
  richText.push(dateMention(new Date().toISOString()));
  if (truncated) {
    richText.push({ type: "text", text: { content: "\n\u26A0\uFE0F File was truncated to 500KB for upload" } });
  }

  const block: BlockObjectRequest = {
    type: "callout",
    callout: {
      rich_text: richText as any,
      icon: { type: "emoji", emoji: "\u2139\uFE0F" },
      color: "gray_background",
    },
  };

  await rateLimiter.schedule(() =>
    notionClient.blocks.children.append({
      block_id: pageId,
      children: [block],
    }),
  );
}

/**
 * Build the rich text content for the root callout block.
 * Uses a date mention for the uploaded timestamp.
 */
export function buildRootCalloutRichText(
  sourceDir: string,
  fileCount: number,
  ignoredPatterns: string[],
  gitBranch?: string,
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  parts.push({ type: "text", text: { content: `\uD83D\uDCC2 Source: ${sourceDir}\n` } });
  if (gitBranch) {
    parts.push({ type: "text", text: { content: `\uD83D\uDD00 Git branch: ${gitBranch}\n` } });
  }
  parts.push({ type: "text", text: { content: `\uD83D\uDCCA Files: ${fileCount}\n\uD83D\uDD52 Uploaded: ` } });
  parts.push(dateMention(new Date().toISOString()));
  parts.push({ type: "text", text: { content: `\n\uD83D\uDEAB Ignored: ${ignoredPatterns.join(", ")}` } });
  return parts;
}

/**
 * Append a summary callout block to the root project page.
 * Returns the created block ID.
 */
export async function appendRootCallout(
  pageId: string,
  sourceDir: string,
  fileCount: number,
  ignoredPatterns: string[],
  gitBranch?: string,
): Promise<string> {
  const richText = buildRootCalloutRichText(sourceDir, fileCount, ignoredPatterns, gitBranch);

  const block: BlockObjectRequest = {
    type: "callout",
    callout: {
      rich_text: richText as any,
      icon: { type: "emoji", emoji: "\uD83D\uDCE6" },
      color: "blue_background",
    },
  };

  const response = await rateLimiter.schedule(() =>
    notionClient.blocks.children.append({
      block_id: pageId,
      children: [block],
    }),
  );
  return response.results[0].id;
}



/**
 * Find a child page by its title under a given parent.
 * Paginates through all children blocks.
 */
export async function findChildPageByTitle(
  parentId: string,
  title: string,
): Promise<string | null> {
  let cursor: string | undefined = undefined;
  do {
    const response = await rateLimiter.schedule(() =>
      notionClient.blocks.children.list({
        block_id: parentId,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    );

    for (const block of response.results) {
      const b = block as Record<string, unknown>;
      if (
        b.type === "child_page" &&
        (b.child_page as { title: string })?.title === title
      ) {
        return b.id as string;
      }
    }

    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return null;
}

/**
 * Delete a block by its ID.
 */
export async function deleteBlock(blockId: string): Promise<void> {
  await rateLimiter.schedule(() =>
    notionClient.blocks.delete({ block_id: blockId }),
  );
}

/**
 * List ALL children of a block, handling pagination.
 */
export async function listAllChildren(
  blockId: string,
): Promise<Array<{ id: string; type: string; [key: string]: unknown }>> {
  const all: Array<{ id: string; type: string; [key: string]: unknown }> = [];
  let cursor: string | undefined = undefined;

  do {
    const response = await rateLimiter.schedule(() =>
      notionClient.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    );

    for (const block of response.results) {
      all.push(block as { id: string; type: string; [key: string]: unknown });
    }

    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return all;
}

/**
 * Update a block in-place via the Notion blocks.update API.
 * The caller provides the block type key and its properties as blockData.
 * Example: updateBlock(id, { callout: { rich_text: [...], icon: ..., color: ... } })
 */
export async function updateBlock(blockId: string, blockData: Record<string, unknown>): Promise<void> {
  await rateLimiter.schedule(() =>
    notionClient.blocks.update({ block_id: blockId, ...blockData }),
  );
}

/**
 * Clear all content from a page by deleting every child block.
 */
export async function clearPageContent(pageId: string): Promise<void> {
  const children = await listAllChildren(pageId);
  for (const child of children) {
    await deleteBlock(child.id);
  }
}

/**
 * Read the manifest from a .manifest child page under the project root.
 * Returns the parsed manifest and its page ID, or null if not found.
 */
export async function readManifest(
  projectRootId: string,
): Promise<{ manifest: Manifest; manifestPageId: string } | null> {
  const manifestPageId = await findChildPageByTitle(
    projectRootId,
    ".manifest",
  );
  if (!manifestPageId) return null;

  try {
    const children = await listAllChildren(manifestPageId);

    // Find the code block
    const codeBlockNode = children.find((b) => b.type === "code");
    if (!codeBlockNode) return null;

    const code = codeBlockNode.code as {
      rich_text: Array<{ plain_text: string }>;
    };
    if (!code?.rich_text) return null;

    const jsonText = code.rich_text.map((rt) => rt.plain_text).join("");
    const manifest = JSON.parse(jsonText) as Manifest;
    return { manifest, manifestPageId };
  } catch {
    return null;
  }
}

/**
 * Write (or overwrite) the manifest as a JSON code block in a .manifest child page.
 * Returns the manifest page ID.
 */
export async function writeManifest(
  projectRootId: string,
  manifest: Manifest,
  existingManifestPageId?: string,
): Promise<string> {
  let manifestPageId: string;

  if (existingManifestPageId) {
    manifestPageId = existingManifestPageId;
    await clearPageContent(manifestPageId);
  } else {
    // File cabinet emoji: \u{1F5C4}\uFE0F
    manifestPageId = await createNotionPage(
      projectRootId,
      ".manifest",
      "\u{1F5C4}\uFE0F",
    );
  }

  const jsonStr = JSON.stringify(manifest, null, 2);

  // Chunk into 2000-char rich text elements
  const MAX_CHUNK = 2000;
  const richText: Array<{ type: "text"; text: { content: string } }> = [];
  let remaining = jsonStr;
  while (remaining.length > 0) {
    richText.push({
      type: "text",
      text: { content: remaining.slice(0, MAX_CHUNK) },
    });
    remaining = remaining.slice(MAX_CHUNK);
  }
  if (richText.length === 0) {
    richText.push({ type: "text", text: { content: "{}" } });
  }

  const block: BlockObjectRequest = {
    type: "code",
    code: {
      rich_text: richText,
      language: "json",
    },
  };

  await rateLimiter.schedule(() =>
    notionClient.blocks.children.append({
      block_id: manifestPageId,
      children: [block],
    }),
  );

  return manifestPageId;
}
