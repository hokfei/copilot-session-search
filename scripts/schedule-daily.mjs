import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { extRoot } from "../lib/paths.mjs";

const execFileAsync = promisify(execFile);

async function main() {
  const script = join(extRoot, "scripts", "daily-reindex.mjs");
  if (process.platform === "win32") {
    const taskName = "SessionSearchDailyReindex";
    const tr = `"${process.execPath}" "${script}"`;
    await execFileAsync("schtasks", [
      "/create",
      "/tn",
      taskName,
      "/tr",
      tr,
      "/sc",
      "daily",
      "/st",
      "03:00",
      "/f",
    ]);
    console.log(`scheduled task "${taskName}" created: daily 03:00 -> ${tr}`);
    console.log("The script also guards with last-run.txt so it never runs twice a day.");
  } else {
    console.log("Add this cron line (daily 03:00):");
    console.log(`0 3 * * * "${process.execPath}" "${script}"`);
    console.log("The script also guards with last-run.txt so it never runs twice a day.");
  }
}

main().catch((err) => {
  console.error(`schedule failed: ${err.message}`);
  process.exitCode = 1;
});
