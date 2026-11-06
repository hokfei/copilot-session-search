import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { extRoot, lastRunPath, buildScriptPath } from "../lib/paths.mjs";

const execFileAsync = promisify(execFile);

function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

async function main() {
  process.chdir(extRoot);
  const stamp = localStamp();
  if (existsSync(lastRunPath) && readFileSync(lastRunPath, "utf8").trim() === stamp) {
    console.log(`already reindexed this hour (${stamp}), skipping`);
    return;
  }
  console.log(`reindex for ${stamp}`);
  const { stdout } = await execFileAsync(process.execPath, [buildScriptPath], {
    cwd: extRoot,
    timeout: 60 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  process.stdout.write(stdout);
  writeFileSync(lastRunPath, stamp + "\n");
  console.log(`stamped ${stamp}`);
}

main().catch((err) => {
  console.error(`reindex failed: ${err.message}`);
  process.exitCode = 1;
});
