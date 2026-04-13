import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import chalk from "chalk";
import type { Config } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig(): Config {
  // Resolve .env from the project root (parent of dist/ or src/)
  const projectRoot = path.resolve(__dirname, "..");
  dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });

  const notionApiToken = process.env.NOTION_API_TOKEN;
  const notionCodebasesPageId = process.env.NOTION_CODEBASES_PAGE_ID;

  if (!notionApiToken) {
    console.error(
      chalk.red("Error: NOTION_API_TOKEN is not set.") + "\n" +
        "Set it in a .env file or as an environment variable.\n" +
        "You can get an integration token at https://www.notion.so/my-integrations",
    );
    process.exit(1);
  }

  if (!notionCodebasesPageId) {
    console.error(
      chalk.red("Error: NOTION_CODEBASES_PAGE_ID is not set.") + "\n" +
        "Set it in a .env file or as an environment variable.\n" +
        'This should be the ID of your "Codebases" parent page in Notion.',
    );
    process.exit(1);
  }

  return { notionApiToken, notionCodebasesPageId };
}
