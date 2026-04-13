import { Client } from "@notionhq/client";
import type { BlockObjectRequest } from "@notionhq/client/build/src/api-endpoints/common.js";
import type { LanguageRequest } from "@notionhq/client/build/src/api-endpoints/common.js";
import { RateLimiter } from "./rate-limiter.js";
import type { GitContext, GitContextBlockMap, Manifest } from "./types.js";
import * as logger from "./logger.js";

let notionClient: Client;
let rateLimiter: RateLimiter;

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
  logger.debug("  Creating git context page...");
  const pageId = await createNotionPage(parentPageId, "Git Context", "\u{1F500}");
  logger.debug("  Git context page created");

  const blockMap = await populateGitContextPage(pageId, ctx);

  return { pageId, blockMap };
}

/**
 * Build the summary callout text for the git context page.
 */
function buildGitSummaryText(ctx: GitContext): string {
  const primaryRemote = ctx.remotes.length > 0 ? ctx.remotes[0].url : "(none)";
  const branchNote = ctx.branchLimitApplied
    ? ` (showing ${ctx.branches.length} of ${ctx.totalBranchCount})`
    : "";
  const tagNote = ctx.totalTagCount > ctx.tags.length
    ? ` (showing ${ctx.tags.length} of ${ctx.totalTagCount})`
    : "";
  return (
    `Remote: ${primaryRemote}\n` +
    `Current branch: ${ctx.currentBranch}\n` +
    `Default branch: ${ctx.defaultBranch}\n` +
    `Total commits: ${ctx.totalCommits}\n` +
    `Repo age: ${formatDate(ctx.repoAge)} \u2192 ${formatDate(ctx.lastCommitDate)}\n` +
    `Branches: ${ctx.totalBranchCount}${branchNote}\n` +
    `Tags: ${ctx.totalTagCount}${tagNote}`
  );
}

/**
 * Build the heading text for a branch toggle.
 */
function buildBranchToggleText(branch: GitContext["branches"][0]): string {
  const indicator = branch.isCurrentBranch ? " \u2B05" : "";
  const commitNote = branch.totalCommitCount > branch.commits.length
    ? ` \u2014 showing ${branch.commits.length} of ${branch.totalCommitCount} commits`
    : "";
  return `${branch.name} (last commit: ${formatDate(branch.lastCommitDate)})${indicator}${commitNote}`;
}

/**
 * Populate a branch toggle with commit children and diffstat sub-toggles.
 * Reused by both populateGitContextPage and updateGitContextPage.
 */
async function populateBranchCommits(
  toggleBlockId: string,
  branch: GitContext["branches"][0],
): Promise<void> {
  if (branch.commits.length === 0) return;

  const dedupedCommits = branch.commits.filter((c) => c.deduplicated);
  if (dedupedCommits.length > 0) {
    logger.debug(`      ${dedupedCommits.length} commit(s) de-duplicated (shown as one-liners)`);
  }

  // Build children: full commits as toggles, deduplicated as plain text paragraphs
  const commitChildren: BlockObjectRequest[] = [];
  for (const commit of branch.commits) {
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

  // Append commit children in batches of 100 (Notion limit)
  const commitBatches = Math.ceil(commitChildren.length / 100);
  for (let j = 0; j < commitChildren.length; j += 100) {
    const batch = commitChildren.slice(j, j + 100);
    if (commitBatches > 1) {
      logger.debug(`      Sending commit batch ${Math.floor(j / 100) + 1}/${commitBatches} (${batch.length} commits)...`);
    }
    await rateLimiter.schedule(() =>
      notionClient.blocks.children.append({
        block_id: toggleBlockId,
        children: batch,
      }),
    );
  }

  // Second pass: append diffstat sub-toggles
  let toggleIndex = 0;
  const commitToggleIndexMap = new Map<number, number>();
  for (let ci = 0; ci < branch.commits.length; ci++) {
    if (!branch.commits[ci].deduplicated) {
      commitToggleIndexMap.set(ci, toggleIndex);
      toggleIndex++;
    }
  }

  const commitsWithDiffstat = branch.commits
    .map((commit, idx) => ({ commit, idx }))
    .filter(({ commit }) => !!commit.diffstat && !commit.deduplicated);

  if (commitsWithDiffstat.length === 0) {
    logger.debug(`      No diffstats for ${branch.name}`);
    return;
  }

  logger.debug(`      Appending diffstats for ${commitsWithDiffstat.length} commit(s) on ${branch.name}...`);
  const branchChildren = await listAllChildren(toggleBlockId);
  const commitBlocks = branchChildren.filter(
    (block) => block.type === "toggle",
  );

  for (const { commit, idx } of commitsWithDiffstat) {
    const tIdx = commitToggleIndexMap.get(idx);
    if (tIdx === undefined || tIdx >= commitBlocks.length) break;
    const commitBlockId = commitBlocks[tIdx].id;

    const diffstatToggle: BlockObjectRequest = {
      type: "toggle",
      toggle: {
        rich_text: [{ type: "text", text: { content: "Diffstat:" }, annotations: { italic: true, bold: false, code: false, strikethrough: false, underline: false, color: "default" } }],
        color: "default",
        children: [codeBlock(commit.diffstat!)],
      },
    } as BlockObjectRequest;

    await rateLimiter.schedule(() =>
      notionClient.blocks.children.append({
        block_id: commitBlockId,
        children: [diffstatToggle],
      }),
    );
  }
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
  const summaryText = buildGitSummaryText(ctx);
  blocks.push({
    type: "callout",
    callout: {
      rich_text: [{ type: "text", text: { content: summaryText } }],
      icon: { type: "emoji", emoji: "\u{1F500}" },
      color: "blue_background",
    },
  });

  // 2. Recent Activity heading
  blocks.push(heading2("Recent Activity (Last 7 Days)"));

  if (ctx.recentActivity.commitsLast7Days.length > 0) {
    const recentLines = ctx.recentActivity.commitsLast7Days.map((c) => {
      const branchTag = c.branches ? ` [${c.branches}]` : "";
      return `${c.shortHash} | ${formatDate(c.date)} | ${c.author} | ${c.subject}${branchTag}`;
    });
    blocks.push(codeBlock(recentLines.join("\n")));
  } else {
    blocks.push(paragraph("No commits in the last 7 days."));
  }

  // Most Changed Files
  if (ctx.recentActivity.hotFiles.length > 0) {
    blocks.push(heading3("Most Changed Files"));
    const hotLines = ctx.recentActivity.hotFiles.map(
      (f) => `${f.count} changes | ${f.file}`,
    );
    blocks.push(codeBlock(hotLines.join("\n")));
  }

  // Active Contributors
  if (ctx.recentActivity.activeContributors.length > 0) {
    blocks.push(heading3("Active Contributors (Last 30 Days)"));
    const contribLines = ctx.recentActivity.activeContributors.map(
      (c) => `${c.commits} commits | ${c.name}`,
    );
    blocks.push(codeBlock(contribLines.join("\n")));
  }

  // Diffstat
  if (ctx.recentActivity.diffstatLast20) {
    blocks.push(heading3("Diffstat (Last 20 Commits)"));
    blocks.push(codeBlock(ctx.recentActivity.diffstatLast20));
  }

  // 4. Branches heading
  blocks.push(heading2("Branches"));

  // Build toggleable heading blocks for each branch (content added separately)
  const branchToggleBlocks: BlockObjectRequest[] = [];
  for (const branch of ctx.branches) {
    branchToggleBlocks.push({
      type: "heading_3",
      heading_3: {
        rich_text: [
          {
            type: "text",
            text: { content: buildBranchToggleText(branch) },
          },
        ],
        is_toggleable: true,
        color: "default",
      },
    } as BlockObjectRequest);
  }

  // 5. Tags heading (only if tags exist)
  const tagBlocks: BlockObjectRequest[] = [];
  if (ctx.tags.length > 0) {
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
  logger.debug(`  Appending ${allTopLevel.length} top-level blocks (${Math.ceil(allTopLevel.length / 100)} batch(es))...`);

  for (let i = 0; i < allTopLevel.length; i += 100) {
    const batch = allTopLevel.slice(i, i + 100);
    const batchNum = Math.floor(i / 100) + 1;
    const totalBatches = Math.ceil(allTopLevel.length / 100);
    if (totalBatches > 1) {
      logger.debug(`    Sending top-level block batch ${batchNum}/${totalBatches} (${batch.length} blocks)...`);
    }
    await rateLimiter.schedule(() =>
      notionClient.blocks.children.append({
        block_id: pageId,
        children: batch,
      }),
    );
  }

  // --- Fetch all page children to build the block map ---
  logger.debug("  Fetching page children to resolve block IDs...");
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

  // 2. Recent Activity heading
  const recentHeading = next();
  blockMap.recentActivityHeadingId = recentHeading.id;

  // 3. Recent Activity code/paragraph
  const recentCode = next();
  blockMap.recentActivityCodeId = recentCode.id;

  // 4-9. Optional sections: hot files, contributors, diffstat
  // These are non-toggleable heading_3 + code pairs
  while (childIdx < allChildren.length) {
    const peek = allChildren[childIdx];
    if (peek.type === "heading_3") {
      const h3 = peek.heading_3 as { is_toggleable?: boolean; rich_text?: Array<{ plain_text?: string }> };
      if (h3?.is_toggleable) break; // Branch toggle \u2014 stop
      const text = h3?.rich_text?.[0]?.plain_text || "";
      const block = next();
      const codeChild = next();
      if (text.startsWith("Most Changed Files")) {
        blockMap.hotFilesHeadingId = block.id;
        blockMap.hotFilesCodeId = codeChild.id;
      } else if (text.startsWith("Active Contributors")) {
        blockMap.contributorsHeadingId = block.id;
        blockMap.contributorsCodeId = codeChild.id;
      } else if (text.startsWith("Diffstat")) {
        blockMap.diffstatHeadingId = block.id;
        blockMap.diffstatCodeId = codeChild.id;
      }
    } else if (peek.type === "heading_2") {
      break; // Branches heading \u2014 stop
    } else {
      childIdx++; // skip unexpected
    }
  }

  // 10. Branches heading
  if (childIdx < allChildren.length && allChildren[childIdx].type === "heading_2") {
    blockMap.branchesHeadingId = next().id;
  }

  // 11. Branch toggles (heading_3 with is_toggleable)
  const toggleBlocks: Array<{ id: string }> = [];
  while (childIdx < allChildren.length) {
    const peek = allChildren[childIdx];
    if (peek.type === "heading_3") {
      const h3 = peek.heading_3 as { is_toggleable?: boolean };
      if (h3?.is_toggleable) {
        toggleBlocks.push(next());
        continue;
      }
    }
    break; // tags section or end
  }

  // 12-13. Optional tags
  if (childIdx < allChildren.length && allChildren[childIdx].type === "heading_2") {
    blockMap.tagsHeadingId = next().id;
    if (childIdx < allChildren.length) {
      blockMap.tagsCodeId = next().id;
    }
  }

  // --- Populate branch commits and record in block map ---
  logger.debug(`  Uploading commit history for ${ctx.branches.length} branch(es)...`);
  for (let i = 0; i < ctx.branches.length && i < toggleBlocks.length; i++) {
    const branch = ctx.branches[i];
    const toggleBlockId = toggleBlocks[i].id;

    if (branch.commits.length === 0) {
      logger.debug(`    [${i + 1}/${ctx.branches.length}] ${branch.name}: no commits, skipping`);
    } else {
      logger.debug(`    [${i + 1}/${ctx.branches.length}] ${branch.name}: ${branch.commits.length} commit(s)...`);
      await populateBranchCommits(toggleBlockId, branch);
    }

    blockMap.branches[branch.name] = {
      toggleId: toggleBlockId,
      lastCommitHash: branch.lastCommitHash,
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
  const summaryText = buildGitSummaryText(ctx);
  await updateBlock(existingBlockMap.calloutId, {
    callout: {
      rich_text: [{ type: "text", text: { content: summaryText } }],
      icon: { type: "emoji", emoji: "\u{1F500}" },
      color: "blue_background",
    },
  });

  // Step 2: Update recent activity section
  await updateBlock(existingBlockMap.recentActivityHeadingId, {
    heading_2: {
      rich_text: [{ type: "text", text: { content: "Recent Activity (Last 7 Days)" } }],
      color: "default",
    },
  });

  if (ctx.recentActivity.commitsLast7Days.length > 0) {
    const recentLines = ctx.recentActivity.commitsLast7Days.map((c) => {
      const branchTag = c.branches ? ` [${c.branches}]` : "";
      return `${c.shortHash} | ${formatDate(c.date)} | ${c.author} | ${c.subject}${branchTag}`;
    });
    await updateBlock(existingBlockMap.recentActivityCodeId, {
      code: { rich_text: chunkedRichText(recentLines.join("\n")), language: "plain text" },
    });
  } else {
    await updateBlock(existingBlockMap.recentActivityCodeId, {
      paragraph: { rich_text: [{ type: "text", text: { content: "No commits in the last 7 days." } }] },
    });
  }

  // Step 3: Update optional sections (hot files, contributors, diffstat)
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
        heading_3: { rich_text: [{ type: "text", text: { content: headingText } }], color: "default" },
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
          children: [heading3(headingText), codeBlock(codeContent)],
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
  const hotFilesContent = ctx.recentActivity.hotFiles.length > 0
    ? ctx.recentActivity.hotFiles.map((f) => `${f.count} changes | ${f.file}`).join("\n")
    : "";
  const hotResult = await updateOptionalSection(
    existingBlockMap.hotFilesHeadingId,
    existingBlockMap.hotFilesCodeId,
    ctx.recentActivity.hotFiles.length > 0,
    "Most Changed Files",
    hotFilesContent,
    lastSectionBlockId,
  );
  newBlockMap.hotFilesHeadingId = hotResult.headingId;
  newBlockMap.hotFilesCodeId = hotResult.codeId;
  if (hotResult.codeId) lastSectionBlockId = hotResult.codeId;

  // Contributors
  const contribContent = ctx.recentActivity.activeContributors.length > 0
    ? ctx.recentActivity.activeContributors.map((c) => `${c.commits} commits | ${c.name}`).join("\n")
    : "";
  const contribResult = await updateOptionalSection(
    existingBlockMap.contributorsHeadingId,
    existingBlockMap.contributorsCodeId,
    ctx.recentActivity.activeContributors.length > 0,
    "Active Contributors (Last 30 Days)",
    contribContent,
    lastSectionBlockId,
  );
  newBlockMap.contributorsHeadingId = contribResult.headingId;
  newBlockMap.contributorsCodeId = contribResult.codeId;
  if (contribResult.codeId) lastSectionBlockId = contribResult.codeId;

  // Diffstat
  const diffstatResult = await updateOptionalSection(
    existingBlockMap.diffstatHeadingId,
    existingBlockMap.diffstatCodeId,
    !!ctx.recentActivity.diffstatLast20,
    "Diffstat (Last 20 Commits)",
    ctx.recentActivity.diffstatLast20 || "",
    lastSectionBlockId,
  );
  newBlockMap.diffstatHeadingId = diffstatResult.headingId;
  newBlockMap.diffstatCodeId = diffstatResult.codeId;

  // Step 4: Update branches
  const existingBranchNames = new Set(Object.keys(existingBlockMap.branches));
  const currentBranchNames = new Set(ctx.branches.map((b) => b.name));

  // Update or skip existing branches
  for (const [branchName, entry] of Object.entries(existingBlockMap.branches)) {
    if (!currentBranchNames.has(branchName)) {
      // Branch deleted \u2014 remove toggle
      logger.debug(`  Deleting removed branch toggle: ${branchName}`);
      await deleteBlock(entry.toggleId);
      continue;
    }

    const branch = ctx.branches.find((b) => b.name === branchName)!;
    if (entry.lastCommitHash === branch.lastCommitHash) {
      // Unchanged \u2014 skip entirely
      logger.debug(`  Skipping branch ${branchName} (unchanged)`);
      newBlockMap.branches[branchName] = entry;
    } else {
      // Changed \u2014 update heading, clear children, repopulate
      logger.debug(`  Updating branch ${branchName} (changed)...`);
      await updateBlock(entry.toggleId, {
        heading_3: {
          rich_text: [{ type: "text", text: { content: buildBranchToggleText(branch) } }],
          is_toggleable: true,
          color: "default",
        },
      });

      // Clear toggle children
      const toggleChildren = await listAllChildren(entry.toggleId);
      for (const child of toggleChildren) {
        await deleteBlock(child.id);
      }

      // Repopulate
      await populateBranchCommits(entry.toggleId, branch);
      newBlockMap.branches[branchName] = {
        toggleId: entry.toggleId,
        lastCommitHash: branch.lastCommitHash,
      };
    }
  }

  // Add new branches
  for (const branch of ctx.branches) {
    if (existingBranchNames.has(branch.name)) continue;
    logger.debug(`  Adding new branch toggle: ${branch.name}`);

    const response = await rateLimiter.schedule(() =>
      notionClient.blocks.children.append({
        block_id: pageId,
        children: [
          {
            type: "heading_3",
            heading_3: {
              rich_text: [{ type: "text", text: { content: buildBranchToggleText(branch) } }],
              is_toggleable: true,
              color: "default",
            },
          } as BlockObjectRequest,
        ],
        after: existingBlockMap.branchesHeadingId,
      }),
    );
    const newToggleId = response.results[0].id;
    await populateBranchCommits(newToggleId, branch);
    newBlockMap.branches[branch.name] = {
      toggleId: newToggleId,
      lastCommitHash: branch.lastCommitHash,
    };
  }

  // Step 5: Update tags
  const hasNewTags = ctx.tags.length > 0;
  const tagHeader = ctx.totalTagCount > ctx.tags.length
    ? `Tags (showing ${ctx.tags.length} of ${ctx.totalTagCount})`
    : "Tags";
  const tagContent = ctx.tags.map((t) => `${t.name} | ${formatDate(t.date)} | ${t.subject}`).join("\n");

  if (existingBlockMap.tagsHeadingId && existingBlockMap.tagsCodeId && hasNewTags) {
    await updateBlock(existingBlockMap.tagsHeadingId, {
      heading_2: { rich_text: [{ type: "text", text: { content: tagHeader } }], color: "default" },
    });
    await updateBlock(existingBlockMap.tagsCodeId, {
      code: { rich_text: chunkedRichText(tagContent), language: "plain text" },
    });
    newBlockMap.tagsHeadingId = existingBlockMap.tagsHeadingId;
    newBlockMap.tagsCodeId = existingBlockMap.tagsCodeId;
  } else if (existingBlockMap.tagsHeadingId && existingBlockMap.tagsCodeId && !hasNewTags) {
    await deleteBlock(existingBlockMap.tagsCodeId);
    await deleteBlock(existingBlockMap.tagsHeadingId);
  } else if (!existingBlockMap.tagsHeadingId && hasNewTags) {
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

/** Create a non-toggleable heading_3 block */
function heading3(text: string): BlockObjectRequest {
  return {
    type: "heading_3",
    heading_3: {
      rich_text: [{ type: "text", text: { content: text } }],
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
 * Create a child page for a directory.
 */
export async function createDirectoryPage(
  parentId: string,
  dirName: string,
): Promise<string> {
  return createNotionPage(parentId, dirName, "\uD83D\uDCC1");
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
  return createNotionPage(parentId, fileName, icon);
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
  const timestamp = new Date().toISOString();
  let text = `\uD83D\uDCC2 ${filePath}\n\uD83D\uDCCA ${fileSize}`;

  if (hash) {
    text += `\n\uD83D\uDD11 ${hash}`;
  }

  text += `\n\uD83D\uDD52 ${timestamp}`;

  if (truncated) {
    text += "\n\u26A0\uFE0F File was truncated to 500KB for upload";
  }

  const block: BlockObjectRequest = {
    type: "callout",
    callout: {
      rich_text: [{ type: "text", text: { content: text } }],
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
 * Build the text content for the root callout block.
 */
export function buildRootCalloutText(
  sourceDir: string,
  fileCount: number,
  ignoredPatterns: string[],
  gitBranch?: string,
): string {
  const timestamp = new Date().toISOString();
  let text = `\uD83D\uDCC2 Source: ${sourceDir}\n`;
  if (gitBranch) {
    text += `\uD83D\uDD00 Git branch: ${gitBranch}\n`;
  }
  text +=
    `\uD83D\uDCCA Files: ${fileCount}\n` +
    `\uD83D\uDD52 Uploaded: ${timestamp}\n` +
    `\uD83D\uDEAB Ignored: ${ignoredPatterns.join(", ")}`;
  return text;
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
  const text = buildRootCalloutText(sourceDir, fileCount, ignoredPatterns, gitBranch);

  const block: BlockObjectRequest = {
    type: "callout",
    callout: {
      rich_text: [{ type: "text", text: { content: text } }],
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
