# code-to-notion

A CLI tool that takes a directory and uploads it to Notion — preserving folder structure, syntax-highlighting files, and generating a git context page with branch history, diffstats, and recent activity. Useful for giving [Notion AI](https://www.notion.so/product/ai) full visibility into your project.

## Features

- Preserves directory structure as nested Notion pages
- **Incremental updates** — detects existing uploads and only re-uploads changed files using content-hash diffing
- **Git context page** — automatically creates a dedicated page with branch history, per-commit diffstats, recent activity, hot files, contributor stats, and tags. Allows Notion to see not just your code, but how it's evolving.
- Syntax highlighting for 40+ languages
- Respects `.gitignore` + sensible defaults
- Handles large files via chunking, with built-in rate limiting and retry
- Dry run, scoped uploads (`--only`), and verbose output

## Setup

**Requires Node.js >= 18**

```sh
git clone https://github.com/lpke/code-to-notion.git
cd code-to-notion
npm install && npm run build
cp .env.example .env
```

Fill in `.env` with:

1. **`NOTION_API_TOKEN`** — Create an integration at [notion.so/my-integrations](https://www.notion.so/my-integrations) with **Read & Insert content** permission. Copy the secret.
2. **`NOTION_CODEBASES_PAGE_ID`** — The 32-char hex ID from the URL of the Notion page you want to upload under. Make sure to connect your integration to this page via **⋯ → Connections**.

## Usage

```sh
code-to-notion <dir> [options]
```

> The above assumes you've run `npm link` from the repo, or added a shell alias:
> ```sh
> alias code-to-notion="node /path/to/code-to-notion/dist/index.js"
> ```

| Option | Description |
| --- | --- |
| `--name <name>` | Override project name (default: directory basename) |
| `--only <dirs...>` | Only include these subdirectories |
| `--ignore <patterns...>` | Additional glob patterns to ignore |
| `--update` | Update existing upload if found (only upload changes) |
| `--replace` | Replace existing upload if found (delete and re-upload) |
| `--skip-git-context` | Skip git context gathering |
| `--dry-run` | Preview file tree without API calls |
| `--concurrency <n>` | Max concurrent API requests (default: 2, max: 3) |
| `--verbose` | Detailed per-file progress |

```sh
code-to-notion ./my-project --dry-run
code-to-notion ./my-project --name "My Project" --only src config
code-to-notion ./my-project --ignore "**/*.test.ts" --verbose
code-to-notion ./my-project --update
code-to-notion ./my-project --replace
code-to-notion ./my-project --update --dry-run
```

## Updating Existing Uploads

On each upload, a `.manifest` page is created under the project root that tracks every file's relative path, Notion page ID, and SHA-256 content hash. This is maintained automatically — no manual intervention is needed.

On subsequent runs, if a page with the same project name already exists, the CLI will prompt you to choose:

1. **Update existing** — reads the manifest, computes local file hashes, and only uploads files that were added or modified. Deleted files are removed from Notion. Unchanged files are skipped entirely. Modified files are updated in-place — the file page stays at its original position, only the content is refreshed. New files and directories are inserted at the correct alphabetical position, not appended at the end.
2. **Replace existing** — deletes the existing page and does a full fresh upload.
3. **Create new** — uploads alongside the existing page (original behaviour).
4. **Cancel** — exits without making changes.

Use `--update` or `--replace` to skip the prompt, which is useful for scripts and CI pipelines.

Combine `--update` with `--dry-run` to preview what would change without uploading:

```sh
code-to-notion ./my-project --update --dry-run
```

## Git Context

For git repos, a **🔀 Git Context** page is created alongside your code containing:

- **Repo info** — remotes, default/current branch, total commits, repo age
- **Branch history** — per-branch commits with full messages and diffstats (50 for default branch, 20 for others). Commits shared across branches are de-duplicated. Repos with 20+ branches are trimmed to the most recently active.
- **Recent activity** — last 7 days of commits, hot files, active contributors
- **Tags** — 10 most recent with dates and annotations

Time-period headings include the actual date range as interactive Notion date mentions. Timestamps in the summary callout and file metadata are rendered as Notion date mentions — timezone-aware and future-proof. The git context page is updated incrementally during `--update` — only changed branches are rebuilt, dramatically reducing API calls.

Disable with `--skip-git-context`.

## License

GPL v3
