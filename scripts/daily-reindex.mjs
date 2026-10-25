import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { extRoot, lastRunPath, buildScriptPath } from "../lib/paths.mjs";

const execFileAsync = promisify(execFile);

function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function main() {
  process.chdir(extRoot);
  const today = localStamp();
  if (existsSync(lastRunPath) && readFileSync(lastRunPath, "utf8").trim() === today) {
    console.log(`already reindexed today (${today}), skipping`);
    return;
  }
  console.log(`daily reindex for ${today}`);
  const { stdout } = await execFileAsync(process.execPath, [buildScriptPath], {
    cwd: extRoot,
    timeout: 60 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  process.stdout.write(stdout);
  writeFileSync(lastRunPath, today + "\n");
  console.log(`stamped ${today}`);
}

main().catch((err) => {
  console.error(`daily reindex failed: ${err.message}`);
  process.exitCode = 1;
});
