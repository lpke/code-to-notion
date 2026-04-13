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

**Prerequisites:** Node.js >= 18, a [Notion integration](https://www.notion.so/my-integrations) with content creation permission, and a parent page connected to the integration.

```sh
git clone https://github.com/lpke/code-to-pages.git
cd code-to-pages
npm install
cp .env.example .env   # then fill in your NOTION_API_TOKEN and NOTION_CODEBASES_PAGE_ID
npm run build
```

## Usage

```sh
code-to-pages <dir> [options]   # after `npm link`
node dist/index.js <dir> [options]
npm run dev -- <dir> [options]  # development
```

### Options

| Option | Description |
| --- | --- |
| `--name <name>` | Override project name (default: directory basename) |
| `--only <dirs...>` | Only include these subdirectories (root files always included) |
| `--ignore <patterns...>` | Additional glob patterns to ignore |
| `--no-git` | Skip git context gathering |
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

When the target is a git repo, a "🔀 Git Context" page is created with repo info, recent activity, per-branch commit details with diffstats, and tags. Repos with >20 branches are limited to the 20 most recently touched (default branch always included). Use `--no-git` to disable.

## License

GPL v3

