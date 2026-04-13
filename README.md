# code-to-pages

A CLI tool that uploads your codebase to Notion as a hierarchy of pages — one page per file, with syntax-highlighted code blocks.

## Why

This tool was primarily built to give [Notion AI](https://www.notion.so/product/ai) your code's context. By uploading your code as Notion pages, you can ask Notion AI questions about your project — and potentially save IDE Agent tokens in the process.

## Features

- Preserves directory structure as nested Notion pages
- Syntax highlighting for 40+ languages
- Respects `.gitignore` + sensible defaults (lock files, binaries, build output, etc.)
- Handles large files via chunking across Notion's API limits
- Built-in rate limiting with automatic retry on 429s
- Dry run mode, scoped uploads (`--only`), and verbose output
- Gathers git context (branches, commits, diffs, tags) into a dedicated page

## Setup

**Prerequisites:** Node.js >= 18

### 1. Clone & install

```sh
git clone https://github.com/lpke/code-to-pages.git
cd code-to-pages
npm install
npm run build
```

### 2. Create a Notion integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) and click **New integration**.
2. Give it a name, ensure it has **Read & Insert content** permission, and submit.
3. Copy the **Internal Integration Secret** — this is your `NOTION_API_TOKEN`.

### 3. Get your parent page ID

Create (or choose) a Notion page where codebases will be uploaded as child pages. Open it in a browser — the page ID is the 32-character hex string at the end of the URL (ignoring any query params). This is your `NOTION_CODEBASES_PAGE_ID`.

> **Important:** Click **⋯ → Connections → Connect to** on that page and add your integration, otherwise the API can't write to it.

### 4. Configure `.env`

```sh
cp .env.example .env
```

Fill in both values:

```
NOTION_API_TOKEN=secret_abc123...
NOTION_CODEBASES_PAGE_ID=a1b2c3d4...
```

## Usage

From the `code-to-pages` directory:

```sh
node dist/index.js <dir> [options]
```

To use it as a command from anywhere, you can either run `npm link` or add a shell alias:

```sh
# Option A: npm link (creates a global symlink)
npm link
code-to-pages <dir> [options]

# Option B: shell alias (add to ~/.bashrc or ~/.zshrc)
alias code-to-pages="node /absolute/path/to/code-to-pages/dist/index.js"
```

For development (runs TypeScript directly):

```sh
npm run dev -- <dir> [options]
```

### Options

| Option | Description |
| --- | --- |
| `--name <name>` | Override project name (default: directory basename) |
| `--only <dirs...>` | Only include these subdirectories (root files always included) |
| `--ignore <patterns...>` | Additional glob patterns to ignore |
| `--skip-git-context` | Skip git context gathering |
| `--dry-run` | Preview file tree without API calls |
| `--concurrency <n>` | Max concurrent API requests (default: 2, max: 3) |
| `--verbose` | Detailed per-file progress |

### Examples

```sh
code-to-pages ./my-project --dry-run
code-to-pages ./my-project --name "My Project" --only src config
code-to-pages ./my-project --ignore "**/*.test.ts" --verbose --concurrency 3
```

## Git Context

When the target is a git repo, a "🔀 Git Context" page is created with repo info, recent activity, per-branch commit details with diffstats, and tags. Repos with >20 branches are limited to the 20 most recently touched (default branch always included). Use `--skip-git-context` to disable.

## License

GPL v3

