import { extRoot } from "../lib/paths.mjs";
import { loadIndex } from "../lib/store.mjs";
import { searchVectors, MAX_LIMIT } from "../lib/search.mjs";
import { embedQuery } from "../lib/embed.mjs";

process.chdir(extRoot);

const failures = [];
function check(name, cond, detail = "") {
  if (cond) console.log(`PASS ${name}`);
  else {
    console.log(`FAIL ${name} ${detail}`);
    failures.push(name);
  }
}

const index = loadIndex();
check("index exists (run npm run build first)", !!index);
if (!index) process.exit(1);
check("index has chunks", index.chunks.length > 0, `chunks=${index.chunks.length}`);
const probeVec = await embedQuery("dimension probe");
check("index dims match live model", index.dims === probeVec.length, `index=${index.dims} model=${probeVec.length}`);

for (const query of ["hello", "mcp server setup", "github copilot extension"]) {
  const qv = await embedQuery(query);
  const results = searchVectors(index.vectors, index.chunks, index.dims, qv, 5);
  check(`query "${query}" returns results`, results.length > 0 && results.length <= 5);
  const desc = results.every((r, i) => i === 0 || results[i - 1].score >= r.score);
  check(`query "${query}" scores descend`, desc);
  const sane = results.every(
    (r) => r.score >= -1.01 && r.score <= 1.01 && r.title && r.snippet && r.sourceType
  );
  check(`query "${query}" fields sane`, sane);
  const perSession = new Map();
  for (const r of results) perSession.set(r.sessionId, (perSession.get(r.sessionId) || 0) + 1);
  const distinctSessions = new Set(index.chunks.map((c) => c.sessionId)).size;
  check(
    `query "${query}" per-session cap`,
    distinctSessions < 3 || Math.max(...perSession.values()) <= 2,
    JSON.stringify([...perSession.values()])
  );
}

const qv = await embedQuery("test");
const capped = searchVectors(index.vectors, index.chunks, index.dims, qv, 999);
check("limit clamps to max", capped.length <= MAX_LIMIT, `got=${capped.length}`);

const probe = index.chunks.find((c) => c.text.length >= 120);
if (probe) {
  const pv = await embedQuery(probe.text.slice(0, 120));
  const top = searchVectors(index.vectors, index.chunks, index.dims, pv, 5);
  check(
    "self-consistency: chunk text finds its session first",
    top.length > 0 && top[0].sessionId === probe.sessionId,
    `top=${top.length ? top[0].sessionId : "none"} want=${probe.sessionId}`
  );
} else {
  check("self-consistency probe chunk exists", false, "no chunk >= 120 chars");
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failing: ${failures.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("\nall tests passed");
}
process.exit(process.exitCode || 0);
