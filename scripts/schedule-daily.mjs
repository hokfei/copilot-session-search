import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { extRoot } from "../lib/paths.mjs";

const execFileAsync = promisify(execFile);

async function main() {
  const script = join(extRoot, "scripts", "daily-reindex.mjs");
  if (process.platform === "win32") {
    const taskName = "SessionSearchReindex";
    const tr = `"${process.execPath}" "${script}"`;
    try {
      await execFileAsync("schtasks", ["/delete", "/tn", "SessionSearchDailyReindex", "/f"]);
    } catch {
      // Already gone (first install or previously migrated).
    }
    await execFileAsync("schtasks", [
      "/create",
      "/tn",
      taskName,
      "/tr",
      tr,
      "/sc",
      "hourly",
      "/mo",
      "1",
      "/st",
      "00:00",
      "/f",
    ]);
    console.log(`scheduled task "${taskName}" created: hourly -> ${tr}`);
    console.log("The script also guards with last-run.txt so it never runs twice an hour.");
    console.log("Then apply catch-up settings (needs no admin):");
    console.log(`powershell -Command "Set-ScheduledTask -TaskName '${taskName}' -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2))"`);
  } else {
    console.log("Add this cron line (hourly):");
    console.log(`0 * * * * "${process.execPath}" "${script}"`);
    console.log("The script also guards with last-run.txt so it never runs twice an hour.");
  }
}

main().catch((err) => {
  console.error(`schedule failed: ${err.message}`);
  process.exitCode = 1;
});
