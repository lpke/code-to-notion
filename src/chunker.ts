/**
 * Notion code blocks use rich text arrays where each element has a max of 2000
 * characters. Each rich text array can hold max 100 elements (~200,000 chars
 * per code block).
 *
 * If a file exceeds 200,000 characters, split into multiple code blocks.
 *
 * Returns an array of code blocks, where each code block is an array of
 * <=2000 char strings.
 */

const RICH_TEXT_MAX_LENGTH = 2000;
const MAX_RICH_TEXT_ELEMENTS = 100;
const MAX_CHARS_PER_BLOCK = RICH_TEXT_MAX_LENGTH * MAX_RICH_TEXT_ELEMENTS;

export function chunkFileContent(content: string): string[][] {
  if (content.length === 0) {
    return [[""]];
  }

  const codeBlocks: string[][] = [];
  let remaining = content;

  while (remaining.length > 0) {
    // Take at most MAX_CHARS_PER_BLOCK for this code block
    const blockContent = remaining.slice(0, MAX_CHARS_PER_BLOCK);
    remaining = remaining.slice(MAX_CHARS_PER_BLOCK);

    const chunks = chunkString(blockContent, RICH_TEXT_MAX_LENGTH);
    codeBlocks.push(chunks);
  }

  return codeBlocks;
}

/**
 * Split a string into chunks of at most `maxLength` characters.
 * Prefers splitting at newline boundaries.
 */
function chunkString(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    if (offset + maxLength >= text.length) {
      // Remaining text fits in one chunk
      chunks.push(text.slice(offset));
      break;
    }

    // Find the last newline within the maxLength window
    const window = text.slice(offset, offset + maxLength);
    const lastNewline = window.lastIndexOf("\n");

    if (lastNewline > 0) {
      // Split after the newline
      chunks.push(text.slice(offset, offset + lastNewline + 1));
      offset += lastNewline + 1;
    } else {
      // No newline found - hard split at maxLength
      chunks.push(window);
      offset += maxLength;
    }
  }

  return chunks;
}
