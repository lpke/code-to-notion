# code-to-pages

A CLI tool that takes a directory and uploads it to Notion — preserving folder structure, syntax-highlighting files, and generating a git context page with branch history, diffstats, and recent activity. Useful for giving [Notion AI](https://www.notion.so/product/ai) full visibility into your project.

## Features

- Preserves directory structure as nested Notion pages
- **Git context page** — automatically creates a dedicated page with branch history, per-commit diffstats, recent activity, hot files, contributor stats, and tags. Allows Notion to see not just your code, but how it's evolving.
- Syntax highlighting for 40+ languages
- Respects `.gitignore` + sensible defaults
- Handles large files via chunking, with built-in rate limiting and retry
- Dry run, scoped uploads (`--only`), and verbose output

## Setup

**Requires Node.js >= 18**

```sh
git clone https://github.com/lpke/code-to-pages.git
cd code-to-pages
npm install && npm run build
cp .env.example .env
```

Fill in `.env` with:

1. **`NOTION_API_TOKEN`** — Create an integration at [notion.so/my-integrations](https://www.notion.so/my-integrations) with **Read & Insert content** permission. Copy the secret.
2. **`NOTION_CODEBASES_PAGE_ID`** — The 32-char hex ID from the URL of the Notion page you want to upload under. Make sure to connect your integration to this page via **⋯ → Connections**.

## Usage

```sh
code-to-pages <dir> [options]
```

> The above assumes you've run `npm link` from the repo, or added a shell alias:
> ```sh
> alias code-to-pages="node /path/to/code-to-pages/dist/index.js"
> ```

| Option | Description |
| --- | --- |
| `--name <name>` | Override project name (default: directory basename) |
| `--only <dirs...>` | Only include these subdirectories |
| `--ignore <patterns...>` | Additional glob patterns to ignore |
| `--skip-git-context` | Skip git context gathering |
| `--dry-run` | Preview file tree without API calls |
| `--concurrency <n>` | Max concurrent API requests (default: 2, max: 3) |
| `--verbose` | Detailed per-file progress |

```sh
code-to-pages ./my-project --dry-run
code-to-pages ./my-project --name "My Project" --only src config
code-to-pages ./my-project --ignore "**/*.test.ts" --verbose
```

## Git Context

For git repos, a **🔀 Git Context** page is created alongside your code containing:

- **Repo info** — remotes, default/current branch, total commits, repo age
- **Branch history** — per-branch commits with full messages and diffstats (50 for default branch, 20 for others). Commits shared across branches are de-duplicated. Repos with 20+ branches are trimmed to the most recently active.
- **Recent activity** — last 7 days of commits, hot files, active contributors
- **Tags** — 10 most recent with dates and annotations

Disable with `--skip-git-context`.

## License

GPL v3

