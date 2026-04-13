import { Client } from "@notionhq/client";
import type { BlockObjectRequest } from "@notionhq/client/build/src/api-endpoints/common.js";
import type { LanguageRequest } from "@notionhq/client/build/src/api-endpoints/common.js";
import { RateLimiter } from "./rate-limiter.js";
import type { GitContext } from "./types.js";

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
): Promise<void> {
  // Create the child page
const pageId = await createNotionPage(parentPageId, "Git Context", "\u{1F500}");

  // --- Build all top-level blocks ---
  const blocks: BlockObjectRequest[] = [];

  // 1. Summary callout
  const primaryRemote = ctx.remotes.length > 0 ? ctx.remotes[0].url : "(none)";
  const branchNote = ctx.branchLimitApplied
    ? ` (showing 10 of ${ctx.totalBranchCount})`
    : "";
  const summaryText =
    `Remote: ${primaryRemote}\n` +
    `Current branch: ${ctx.currentBranch}\n` +
    `Default branch: ${ctx.defaultBranch}\n` +
    `Total commits: ${ctx.totalCommits}\n` +
    `Repo age: ${formatDate(ctx.repoAge)} \u2192 ${formatDate(ctx.lastCommitDate)}\n` +
    `Branches: ${ctx.totalBranchCount}${branchNote}`;

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
    const indicator = branch.isCurrentBranch ? " \u2B05" : "";
    branchToggleBlocks.push({
      type: "heading_3",
      heading_3: {
        rich_text: [
          {
            type: "text",
            text: {
              content: `${branch.name} (last commit: ${formatDate(branch.lastCommitDate)})${indicator}`,
            },
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
    tagBlocks.push(heading2("Tags"));
    const tagLines = ctx.tags.map(
      (t) => `${t.name} | ${formatDate(t.date)} | ${t.subject}`,
    );
    tagBlocks.push(codeBlock(tagLines.join("\n")));
  }

  // --- Append all top-level blocks in batches ---
  // Combine: blocks + branchToggleBlocks + tagBlocks
  const allTopLevel = [...blocks, ...branchToggleBlocks, ...tagBlocks];

  for (let i = 0; i < allTopLevel.length; i += 100) {
    const batch = allTopLevel.slice(i, i + 100);
    await rateLimiter.schedule(() =>
      notionClient.blocks.children.append({
        block_id: pageId,
        children: batch,
      }),
    );
  }

  // --- Append toggle content for each branch ---
  // We need to find the IDs of the toggle heading blocks we just created.
  // Fetch children of the page to get their IDs.
  const pageChildren = await rateLimiter.schedule(() =>
    notionClient.blocks.children.list({
      block_id: pageId,
      page_size: 100,
    }),
  );

  // Find the toggle heading blocks (heading_3 with is_toggleable)
  const toggleBlocks = pageChildren.results.filter((block: Record<string, unknown>) => {
    if (block.type !== "heading_3") return false;
    const h3 = block.heading_3 as { is_toggleable?: boolean };
    return h3?.is_toggleable === true;
  });

  // For each branch, create per-commit toggle blocks inside the branch H3
  for (let i = 0; i < ctx.branches.length && i < toggleBlocks.length; i++) {
    const branch = ctx.branches[i];
    const toggleBlockId = toggleBlocks[i].id;

    if (branch.commits.length === 0) continue;

    // First pass: build commit toggle blocks (with body paragraphs as children,
    // but WITHOUT diffstat sub-toggles to stay within Notion's 2-level nesting limit)
    const commitToggleChildren: BlockObjectRequest[] = [];
    for (const commit of branch.commits) {
      const toggleText = `${commit.shortHash} | ${formatDate(commit.date)} | ${commit.author} | ${commit.subject}`;

      // Children inside the commit toggle (level 2 relative to branch H3)
      const innerChildren: BlockObjectRequest[] = [];
      if (commit.body) {
        innerChildren.push(paragraph(commit.body));
      }

      commitToggleChildren.push({
        type: "toggle",
        toggle: {
          rich_text: [{ type: "text", text: { content: toggleText } }],
          color: "default",
          ...(innerChildren.length > 0 ? { children: innerChildren } : {}),
        },
      } as BlockObjectRequest);
    }

    // Append commit toggles in batches of 100 (Notion limit)
    for (let j = 0; j < commitToggleChildren.length; j += 100) {
      const batch = commitToggleChildren.slice(j, j + 100);
      await rateLimiter.schedule(() =>
        notionClient.blocks.children.append({
          block_id: toggleBlockId,
          children: batch,
        }),
      );
    }

    // Second pass: fetch the newly created commit toggle block IDs,
    // then append diffstat sub-toggles into each commit toggle that has a diffstat
    const commitsWithDiffstat = branch.commits
      .map((commit, idx) => ({ commit, idx }))
      .filter(({ commit }) => !!commit.diffstat);

    if (commitsWithDiffstat.length === 0) continue;

    // Fetch all children of the branch toggle to get commit toggle IDs
    const branchChildren = await rateLimiter.schedule(() =>
      notionClient.blocks.children.list({
        block_id: toggleBlockId,
        page_size: 100,
      }),
    );

    // The commit toggle blocks should be in order
    const commitBlocks = branchChildren.results.filter(
      (block: Record<string, unknown>) => block.type === "toggle",
    );

    for (const { commit, idx } of commitsWithDiffstat) {
      if (idx >= commitBlocks.length) break;
      const commitBlockId = commitBlocks[idx].id;

      const diffstatToggle: BlockObjectRequest = {
        type: "toggle",
        toggle: {
          rich_text: [{ type: "text", text: { content: "Diffstat" } }],
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
  // Notion rich text elements are limited to 2000 chars each
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
  return {
    type: "code",
    code: {
      rich_text: richText,
      language: "plain text",
    },
  };
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
): Promise<void> {
  const timestamp = new Date().toISOString();
  let text = `\uD83D\uDCC2 ${filePath}\n\uD83D\uDCCA ${fileSize}\n\uD83D\uDD52 ${timestamp}`;

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
 * Append a summary callout block to the root project page.
 */
export async function appendRootCallout(
  pageId: string,
  sourceDir: string,
  fileCount: number,
  ignoredPatterns: string[],
  gitBranch?: string,
): Promise<void> {
  const timestamp = new Date().toISOString();
  let text = `\uD83D\uDCC2 Source: ${sourceDir}\n`;
  if (gitBranch) {
    text += `\uD83D\uDD00 Git branch: ${gitBranch}\n`;
  }
  text +=
    `\uD83D\uDCCA Files: ${fileCount}\n` +
    `\uD83D\uDD52 Uploaded: ${timestamp}\n` +
    `\uD83D\uDEAB Ignored: ${ignoredPatterns.join(", ")}`;

  const block: BlockObjectRequest = {
    type: "callout",
    callout: {
      rich_text: [{ type: "text", text: { content: text } }],
      icon: { type: "emoji", emoji: "\uD83D\uDCE6" },
      color: "blue_background",
    },
  };

  await rateLimiter.schedule(() =>
    notionClient.blocks.children.append({
      block_id: pageId,
      children: [block],
    }),
  );
}
