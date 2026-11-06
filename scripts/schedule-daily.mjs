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
      "hourly",
      "/mo",
      "3",
      "/st",
      "00:00",
      "/f",
    ]);
    console.log(`scheduled task "${taskName}" created: every 3h -> ${tr}`);
    console.log("The script also guards with last-run.txt so it never runs twice an hour.");
    console.log("Then apply catch-up settings (needs no admin):");
    console.log(`powershell -Command "Set-ScheduledTask -TaskName '${taskName}' -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2))"`);
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
