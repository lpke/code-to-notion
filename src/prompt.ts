import readline from "node:readline";
import chalk from "chalk";
import type { ExistingAction } from "./types.js";

/**
 * Prompt the user to choose what to do when a project with the same name
 * already exists. Must be called BEFORE startCancellationListener() since
 * that puts stdin into raw mode.
 */
export async function promptExistingAction(
  projectName: string,
): Promise<ExistingAction> {
  console.log("");
  console.log(
    chalk.yellow(`⚠ A project named "${projectName}" already exists.`),
  );
  console.log("");
  console.log(`  ${chalk.cyan("1.")} Update existing (only upload changes)`);
  console.log(`  ${chalk.cyan("2.")} Replace existing (delete and re-upload)`);
  console.log(`  ${chalk.cyan("3.")} Create new (keep both)`);
  console.log(`  ${chalk.cyan("4.")} Cancel`);
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<ExistingAction>((resolve) => {
    rl.question(chalk.cyan("Choice [1-4]: "), (answer) => {
      rl.close();
      const trimmed = answer.trim();
      switch (trimmed) {
        case "1":
          resolve("update");
          break;
        case "2":
          resolve("replace");
          break;
        case "3":
          resolve("new");
          break;
        default:
          resolve("cancel");
          break;
      }
    });
  });
}
