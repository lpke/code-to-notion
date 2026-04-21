# code-to-notion

CLI tool that uploads a codebase to Notion — preserving folder structure, syntax-highlighting files, and generating a git context page with branch history, diffstats, and recent activity. Useful for giving [Notion AI](https://www.notion.so/product/ai) full visibility into your project.

## Features

- Preserves directory structure as nested Notion pages
- **Incremental updates** — content-hash diffing, only re-uploads what changed
- **Git context page** — branch history, per-commit diffstats, hot files, contributor stats, tags
- Syntax highlighting for 40+ languages
- Respects `.gitignore` + sensible defaults
- Large-file chunking with built-in rate limiting and retry
- Dry run, scoped uploads (`--only`), and verbose output

## Setup

**Requires Node.js ≥ 18**

```sh
git clone https://github.com/lpke/code-to-notion.git
cd code-to-notion
npm install && npm run build
cp .env.example .env
```

Fill in `.env`:

| Variable | Where to get it |
| --- | --- |
| `NOTION_API_TOKEN` | Create an integration at [notion.so/my-integrations](https://www.notion.so/my-integrations) with **Read & Insert content** permission. Copy the secret. |
| `NOTION_CODEBASES_PAGE_ID` | The 32-char hex ID from the URL of the Notion page you want to upload under. Connect your integration via **⋯ → Connections**. |

## Usage

```sh
code-to-notion <dir> [options]
```

> Assumes you've run `npm link` from the repo, or added a shell alias:
> ```sh
> alias code-to-notion="node /path/to/code-to-notion/dist/index.js"
> ```

### Options

| Flag | Description |
| --- | --- |
| `--name <name>` | Override project name (default: directory basename) |
| `--only <dirs...>` | Only include these subdirectories |
| `--ignore <patterns...>` | Additional glob patterns to ignore |
| `--update` | Update existing upload (only upload changes) |
| `--replace` | Replace existing upload (delete and re-upload) |
| `--skip-git-context` | Skip git context gathering |
| `--dry-run` | Preview file tree without API calls |
| `--concurrency <n>` | Max concurrent API requests (default: 2, max: 3) |
| `--verbose` | Detailed per-file progress |

### Examples

```sh
# Preview what would be uploaded
code-to-notion ./my-project --dry-run

# Upload specific directories with a custom name
code-to-notion ./my-project --name "My Project" --only src config

# Ignore test files
code-to-notion ./my-project --ignore "**/*.test.ts" --verbose

# Incremental update
code-to-notion ./my-project --update

# Full re-upload
code-to-notion ./my-project --replace

# Preview what an update would change
code-to-notion ./my-project --update --dry-run
```

## Incremental Updates

Each upload creates a `.manifest` page under the project root that tracks every file's path, Notion page ID, and SHA-256 content hash. This is maintained automatically.

On subsequent runs, if a page with the same project name already exists, you're prompted to choose:

1. **Update existing** — reads the manifest, diffs local hashes, and uploads only added/modified files. Deleted files are removed from Notion. Modified files are updated in-place (same page, refreshed content). New files and directories are inserted at the correct alphabetical position.
2. **Replace existing** — deletes the existing page and does a full fresh upload.
3. **Create new** — uploads alongside the existing page.
4. **Cancel** — exits without changes.

Use `--update` or `--replace` to skip the prompt (useful for scripts/CI).

## Git Context

For git repos, a **🔀 Git Context** page is created alongside your code containing:

- **Repo info** — remotes, default/current branch, total commits, repo age
- **Branch history** — per-branch commits with full messages and diffstats (50 for default branch, 20 for others). Shared commits are de-duplicated; repos with 20+ branches are trimmed to the most recently active.
- **Recent activity** — last 7 days of commits, hot files, active contributors
- **Tags** — 10 most recent with dates and annotations

Time-period headings include actual date ranges as Notion date mentions. Timestamps are rendered as timezone-aware Notion date mentions throughout. The git context page is updated incrementally during `--update` — only changed branches are rebuilt.

Disable with `--skip-git-context`.

## License

This project is licensed under the GNU Affero General Public License v3.0 only. Full text: [LICENSE](./LICENSE).

Copyright © 2026 Luke Perich ([lpdev.io](https://www.lpdev.io))

