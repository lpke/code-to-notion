import { Client } from "@notionhq/client";
import type { BlockObjectRequest } from "@notionhq/client/build/src/api-endpoints/common.js";
import type { LanguageRequest } from "@notionhq/client/build/src/api-endpoints/common.js";
import { RateLimiter } from "./rate-limiter.js";

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
): Promise<void> {
  const timestamp = new Date().toISOString();
  const text =
    `\uD83D\uDCC2 Source: ${sourceDir}\n` +
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
