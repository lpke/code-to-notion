# code-to-pages

A CLI tool that uploads your codebase to Notion as a hierarchy of pages — one page per file, with syntax-highlighted code blocks.

## Why?

Sometimes you want your code browsable directly in Notion — for documentation, code reviews, or feeding context to AI tools that integrate with Notion. `code-to-pages` mirrors your project's directory structure as nested Notion pages, with each file's content rendered in syntax-highlighted code blocks.

## Features

- **Preserves directory structure** — folders become parent pages, files become child pages with code blocks
- **Syntax highlighting** — auto-detects language from file extensions for 40+ languages
- **Smart filtering** — respects `.gitignore`, ignores common non-essential files (lock files, binaries, build output, `node_modules`, etc.)
- **Chunking** — handles large files by splitting content across Notion's rich text and code block limits
- **Rate limiting** — built-in concurrency control and automatic retry on Notion API 429 responses
- **Dry run mode** — preview the file tree without making any API calls
- **Scoped uploads** — use `--only` to upload specific subdirectories while keeping root-level files

## Prerequisites

- Node.js >= 18
- A [Notion integration](https://www.notion.so/my-integrations) with permission to create content
- A parent page in Notion where codebases will be uploaded (the integration must be connected to this page)

## Setup

1. **Clone and install:**

   ```sh
   git clone https://github.com/lpke/code-to-pages.git
   cd code-to-pages
   npm install
   ```

2. **Configure environment variables:**

   ```sh
   cp .env.example .env
   ```

   Edit `.env` with your credentials:

   ```sh
   NOTION_API_TOKEN=secret_...       # Your Notion integration token
   NOTION_CODEBASES_PAGE_ID=<id>     # ID of the parent page for uploads
   ```

   > To find a page ID, open the page in Notion, click **Share → Copy link**, and extract the 32-character hex string from the URL.

3. **Build:**

   ```sh
   npm run build
   ```

## Usage

```sh
# Run directly via tsx (development)
npm run dev -- <dir> [options]

# Or run the built version
node dist/index.js <dir> [options]

# Or link globally
npm link
code-to-pages <dir> [options]
```

### Arguments

| Argument | Description |
| -------- | ---------------------------------- |
| `<dir>`  | Target directory to upload |

### Options

| Option | Description |
| ----------------------------- | --------------------------------------------------------------- |
| `--name <name>` | Override the project name (defaults to the directory basename) |
| `--only <dirs...>` | Only include these subdirectories (root-level files are always included) |
| `--ignore <patterns...>` | Additional glob patterns to ignore on top of defaults |
| `--no-git` | Skip git context gathering even if `.git` exists |
| `--dry-run` | Print the file tree without calling the Notion API |
| `--concurrency <n>` | Max concurrent API requests (default: 2, max: 3) |
| `--verbose` | Print detailed per-file progress |
| `-V, --version` | Show version number |
| `-h, --help` | Show help |

### Examples

```sh
# Preview what would be uploaded
code-to-pages ./my-project --dry-run

# Upload a project
code-to-pages ./my-project

# Upload with a custom name
code-to-pages ./my-project --name "My Cool Project"

# Only upload the src and config directories (plus root files)
code-to-pages ./my-project --only src config

# Ignore test files and docs
code-to-pages ./my-project --ignore "**/*.test.ts" "docs/**"

# Verbose output with higher concurrency
code-to-pages ./my-project --verbose --concurrency 3

# Skip git context gathering
code-to-pages ./my-project --no-git
```

## Default Ignore Patterns

The following are always excluded (in addition to `.gitignore` rules):

- **Directories:** `node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `.nuxt`, `.cache`, `coverage`, `__pycache__`
- **Files:** lock files (`*.lock`, `package-lock.json`, etc.), source maps (`*.map`), minified files (`*.min.js`, `*.min.css`), binary/media files (images, fonts, archives, etc.)
- **Empty files** are also skipped

## How It Works

1. **Scan** — Walks the target directory using [fast-glob](https://github.com/mrmlnc/fast-glob), filtering by ignore patterns and `--only` scope
2. **Build tree** — Constructs an in-memory file tree with detected languages and file sizes
3. **Create pages** — Creates a root page under your configured parent, then recursively creates child pages for directories and files
4. **Upload content** — Reads each file, chunks the content to fit Notion's limits (2,000 chars per rich text element, 100 elements per code block), and appends syntax-highlighted code blocks
5. **Metadata** — Each file page gets a callout with its path, size, and upload timestamp; the root page gets a summary callout

Files larger than 500KB are truncated with a warning.

### Git Context

When the target directory is a git repository, `code-to-pages` automatically gathers comprehensive git metadata and creates a dedicated "🔀 Git Context" page at the root level of the project in Notion, alongside the file tree. This page appears before the file tree and includes:

- **Repository info** — remote URLs, current/default branch, total commits, repo age
- **Recent activity** — commits from the last 7 days, most frequently changed files, active contributors, diffstat of the last 20 commits
- **Branch details** — each branch gets a toggleable section; inside, each commit gets its own nested toggle showing the commit body (if any) and a collapsible diffstat for the 10 most recent commits
- **Tags** — the 10 most recent tags

**Branch limits:**
- If a repository has more than 20 branches, git context is skipped entirely (an error is logged)
- If a repository has more than 10 branches (but ≤ 20), only the 10 most recently committed branches are included (a warning is logged)
- If a repository has 10 or fewer branches, all branches are included

To skip git context gathering, use the `--no-git` flag. Git context is also skipped during `--dry-run`.

## Project Structure

```
src/
├── index.ts          # CLI entry point (commander setup)
├── config.ts         # Environment variable loading
├── types.ts          # Shared TypeScript types
├── files.ts          # File tree building, globbing, language detection
├── git.ts            # Git metadata extraction
├── chunker.ts        # Content chunking for Notion's API limits
├── notion.ts         # Notion API interactions (pages, blocks)
├── rate-limiter.ts   # Concurrency control and 429 retry handling
└── logger.ts         # Colored output, spinners, tree printing
```

## License

GPL v3

