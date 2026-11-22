import { searchVectors } from "../lib/search.mjs";
import { saveIndex, loadIndex, assertSafeToPublish, modelFileIdentity, shouldFullReembed, partialWarningSuffix, formatDoneLine } from "../lib/store.mjs";
import { readAllDocsWithFailures, readAllDocs } from "../lib/read.mjs";
import { extRoot, indexBinPath, indexMetaPath } from "../lib/paths.mjs";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  utimesSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

process.chdir(extRoot);

const failures = [];
function check(name, cond, detail = "") {
  if (cond) console.log(`PASS ${name}`);
  else {
    console.log(`FAIL ${name} ${detail}`);
    failures.push(name);
  }
}

function sha1Of(buf) {
  return createHash("sha1").update(buf).digest("hex");
}

// Safety: real index must never be touched (all save/load use temp via INDEX_*).
const realBinSha0 = existsSync(indexBinPath) ? sha1Of(readFileSync(indexBinPath)) : null;
const realMetaSha0 = existsSync(indexMetaPath) ? sha1Of(readFileSync(indexMetaPath)) : null;

function snapshotEnv(keys) {
  const snap = {};
  for (const k of keys) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap) {
  for (const k of Object.keys(snap)) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

// ---------------------------------------------------------------- search: capped merge scans full list
{
  const dims = 4;
  const chunks = [];
  const vectors = new Float32Array(27 * dims);
  for (let i = 0; i < 27; i++) {
    const sess = i < 22 ? "A" : "B";
    chunks.push({
      sessionId: sess,
      title: `t${i}`,
      sourceType: "u",
      date: null,
      text: `x${i}`,
    });
    vectors[i * dims] = i < 22 ? 30 - i : 5 - (i - 22);
  }
  let out = [];
  let threw = null;
  try {
    out = searchVectors(vectors, chunks, dims, [1, 0, 0, 0], 5);
  } catch (err) {
    threw = err;
  }
  check("search runs without throw (starvation fixture)", threw === null, threw ? threw.message : "");
  const gotSessions = out.map((r) => r.sessionId).join(",");
  check(
    "search starvation: B appears with limit 5 (22A outscore 5B)",
    out.some((r) => r.sessionId === "B"),
    `got=${gotSessions}`
  );
  check("search starvation: fills to limit 5 (soft-cap refill)", out.length === 5, `got=${out.length}`);
  // Limit 5 with only 2 sessions: diverse first pass yields 4 picks
  // ([30,29,5,4]) and soft-cap refill adds the next-best untaken row
  // (28, A); final sort restores rank order to [30,29,28,5,4].
  check(
    "search starvation: exact session order [A,A,A,B,B]",
    JSON.stringify(out.map((r) => r.sessionId)) === JSON.stringify(["A", "A", "A", "B", "B"]),
    `got=${gotSessions}`
  );
  check(
    "search starvation: exact scores [30,29,28,5,4]",
    JSON.stringify(out.map((r) => r.score)) === JSON.stringify([30, 29, 28, 5, 4]),
    `got=${out.map((r) => r.score).join(",")}`
  );
  const desc5 = out.every((r, i) => i === 0 || out[i - 1].score >= r.score);
  check("search starvation limit 5: scores descend (rank order)", desc5, `scores=${out.map((r) => r.score).join(",")}`);
  // Scores descend whenever no out-of-order refill is needed: limit 4 needs no refill.
  const out4 = searchVectors(vectors, chunks, dims, [1, 0, 0, 0], 4);
  const desc4 = out4.every((r, i) => i === 0 || out4[i - 1].score >= r.score);
  check("search starvation limit 4: scores descend (no refill)", desc4, `scores=${out4.map((r) => r.score).join(",")}`);
  check(
    "search starvation limit 4: exact scores [30,29,5,4]",
    JSON.stringify(out4.map((r) => r.score)) === JSON.stringify([30, 29, 5, 4]),
    `got=${out4.map((r) => r.score).join(",")}`
  );
}

{
  // Single session must still fill to limit via soft-cap refill (cap is 2, limit is 5).
  const dims = 2;
  const chunks = Array.from({ length: 5 }, (_, i) => ({
    sessionId: "ONLY",
    title: `t${i}`,
    sourceType: "u",
    date: null,
    text: `x${i}`,
  }));
  const vectors = new Float32Array(5 * dims);
  for (let i = 0; i < 5; i++) vectors[i * dims] = 10 - i;
  let out = [];
  let threw = null;
  try {
    out = searchVectors(vectors, chunks, dims, [1, 0], 5);
  } catch (err) {
    threw = err;
  }
  check("search refill runs without throw (single session)", threw === null, threw ? threw.message : "");
  check("search soft-cap refill: single session fills to limit 5", out.length === 5, `got=${out.length}`);
  const desc = out.every((r, i) => i === 0 || out[i - 1].score >= r.score);
  check("search soft-cap refill: scores descend", desc, `scores=${out.map((r) => r.score).join(",")}`);
}

// ---------------------------------------------------------------- assertSafeToPublish
{
  let threw = false;
  try {
    assertSafeToPublish({ docsCount: 5, failures: [{ source: "x", reason: "y" }], oldChunks: 10 });
  } catch {
    threw = true;
  }
  check("assertSafeToPublish docsCount>0 returns quietly", threw === false);
}
{
  let msg = "";
  let threw = false;
  try {
    assertSafeToPublish({ docsCount: 0, failures: [], oldChunks: 7 });
  } catch (err) {
    threw = true;
    msg = err.message;
  }
  check(
    "assertSafeToPublish empty over existing throws /empty index over 7/",
    threw && /empty index over 7/.test(msg),
    `message=${JSON.stringify(msg)}`
  );
}
{
  const src = "C:/fake/source.db";
  let msg = "";
  let threw = false;
  try {
    assertSafeToPublish({
      docsCount: 0,
      failures: [{ source: src, reason: "unopenable: boom" }],
      oldChunks: 7,
    });
  } catch (err) {
    threw = true;
    msg = err.message;
  }
  check(
    "assertSafeToPublish empty over existing includes failure source detail",
    threw && msg.includes(src),
    `message=${JSON.stringify(msg)}`
  );
}
{
  let msg = "";
  let threw = false;
  try {
    assertSafeToPublish({ docsCount: 0, failures: [], oldChunks: 0 });
  } catch (err) {
    threw = true;
    msg = err.message;
  }
  check(
    "assertSafeToPublish fresh empty throws /nothing to publish/",
    threw && /nothing to publish/.test(msg),
    `message=${JSON.stringify(msg)}`
  );
}
{
  const src = "C:/fake/other.db";
  let msg = "";
  let threw = false;
  try {
    assertSafeToPublish({
      docsCount: 0,
      failures: [{ source: src, reason: "unreadable: nope" }],
      oldChunks: 0,
    });
  } catch (err) {
    threw = true;
    msg = err.message;
  }
  check(
    "assertSafeToPublish fresh empty with failures includes source detail",
    threw && msg.includes(src) && /nothing to publish/.test(msg),
    `message=${JSON.stringify(msg)}`
  );
}
// Red basis (code-evident): pre-fix signature had no defaults, so () threw TypeError.
{
  let msg = "";
  let threw = false;
  let isTypeError = false;
  try {
    assertSafeToPublish();
  } catch (err) {
    threw = true;
    msg = err.message;
    isTypeError = err instanceof TypeError;
  }
  check(
    "assertSafeToPublish() no-arg throws friendly /nothing to publish/",
    threw && !isTypeError && /nothing to publish/.test(msg),
    `message=${JSON.stringify(msg)} isTypeError=${isTypeError}`
  );
}

// ---------------------------------------------------------------- R3 pure helpers (shouldFullReembed/partialWarningSuffix/formatDoneLine)
// Red basis (code-evident): helpers did not exist pre-R3; build-index had inline logic.
{
  check("shouldFullReembed null oldMeta → false", shouldFullReembed(null, "10:20") === false);
}
{
  check(
    "shouldFullReembed legacy undefined identity → false",
    shouldFullReembed({ modelIdentity: undefined }, "10:20") === false
  );
}
{
  check(
    "shouldFullReembed matching identity → false",
    shouldFullReembed({ modelIdentity: "10:20" }, "10:20") === false
  );
}
{
  check(
    "shouldFullReembed mismatching identity → true",
    shouldFullReembed({ modelIdentity: "10:20" }, "10:21") === true
  );
}
{
  check(
    "shouldFullReembed old null vs current string → true",
    shouldFullReembed({ modelIdentity: null }, "10:20") === true
  );
}
{
  check(
    "shouldFullReembed old string vs current null → true",
    shouldFullReembed({ modelIdentity: "10:20" }, null) === true
  );
}
{
  check(
    "shouldFullReembed both null → false",
    shouldFullReembed({ modelIdentity: null }, null) === false
  );
}
{
  check("partialWarningSuffix 0 → empty", partialWarningSuffix(0) === "");
}
{
  check(
    "partialWarningSuffix 2 → WARNING suffix",
    partialWarningSuffix(2) === " (WARNING: partial index, 2 source problems — see log above)",
    `got=${JSON.stringify(partialWarningSuffix(2))}`
  );
}
{
  check(
    "partialWarningSuffix 1 → WARNING suffix (plural pinned)",
    partialWarningSuffix(1) === " (WARNING: partial index, 1 source problems — see log above)",
    `got=${JSON.stringify(partialWarningSuffix(1))}`
  );
}
{
  check(
    "formatDoneLine 0 failures → plain line",
    formatDoneLine(10, 4, 0) === "wrote index: 10 chunks, 4 dims",
    `got=${JSON.stringify(formatDoneLine(10, 4, 0))}`
  );
}
{
  check(
    "formatDoneLine 2 failures → line + suffix",
    formatDoneLine(10, 4, 2) === "wrote index: 10 chunks, 4 dims (WARNING: partial index, 2 source problems — see log above)",
    `got=${JSON.stringify(formatDoneLine(10, 4, 2))}`
  );
}

// ---------------------------------------------------------------- read shapes (live local sources, shapes only, skip-on-unavailable)
// R3 advisory: isolate from test env (clear overrides for true live) and skip if live DB locked/corrupt throws.
{
  const snapLive = snapshotEnv(["SESSION_SEARCH_SESSION_STORE_DB", "SESSION_SEARCH_DATA_DB", "SESSION_SEARCH_STATE_DIR"]);
  delete process.env.SESSION_SEARCH_SESSION_STORE_DB;
  delete process.env.SESSION_SEARCH_DATA_DB;
  delete process.env.SESSION_SEARCH_STATE_DIR;
  let res = null;
  let threw = null;
  try {
    try {
      res = readAllDocsWithFailures();
    } catch (err) {
      threw = err;
    }
    if (threw) {
      check("readAllDocsWithFailures runs without throw", true, `SKIP live unavailable: ${threw.message}`);
      check("readAllDocsWithFailures returns docs array", true, "SKIP live unavailable");
      check("readAllDocsWithFailures returns failures array", true, "SKIP live unavailable");
      check("readAllDocsWithFailures every failure has string source+reason", true, "SKIP live unavailable");
      check("readAllDocsWithFailures docs have string sessionId+text", true, "SKIP live unavailable");
    } else {
      check("readAllDocsWithFailures runs without throw", true);
      const docs = res.docs;
      const fails = res.failures;
      check("readAllDocsWithFailures returns docs array", Array.isArray(docs));
      check("readAllDocsWithFailures returns failures array", Array.isArray(fails));
      check(
        "readAllDocsWithFailures every failure has string source+reason",
        Array.isArray(fails) && fails.every((f) => typeof f.source === "string" && typeof f.reason === "string"),
        `failures=${fails.length}`
      );
      check(
        "readAllDocsWithFailures docs have string sessionId+text",
        Array.isArray(docs) && docs.every((d) => typeof d.sessionId === "string" && typeof d.text === "string"),
        `docs=${docs.length}`
      );
    }
  } finally {
    restoreEnv(snapLive);
  }
}
{
  const snapLive2 = snapshotEnv(["SESSION_SEARCH_SESSION_STORE_DB", "SESSION_SEARCH_DATA_DB", "SESSION_SEARCH_STATE_DIR"]);
  delete process.env.SESSION_SEARCH_SESSION_STORE_DB;
  delete process.env.SESSION_SEARCH_DATA_DB;
  delete process.env.SESSION_SEARCH_STATE_DIR;
  let docs = null;
  let threw = null;
  try {
    try {
      docs = readAllDocs();
    } catch (err) {
      threw = err;
    }
    if (threw) {
      check("readAllDocs runs without throw", true, `SKIP live unavailable: ${threw.message}`);
      check("readAllDocs returns plain docs array", true, "SKIP live unavailable");
    } else {
      check("readAllDocs runs without throw", true);
      check("readAllDocs returns plain docs array", Array.isArray(docs));
    }
  } finally {
    restoreEnv(snapLive2);
  }
}

// ---------------------------------------------------------------- read fixtures (isolated via temp dirs + SESSION_* env)
// Red basis for all isolated read tests (code-evident): SESSION_SEARCH_* overrides
// did not exist pre-fix, so fixtures would have read live sources and counts would not match.
{
  const tmpRoot = mkdtempSync(join(tmpdir(), "ss-unit-read-ev-"));
  const stateDir = join(tmpRoot, "state");
  const sessDir = join(stateDir, "sess-ev1");
  mkdirSync(sessDir, { recursive: true });
  const eventsPath = join(sessDir, "events.jsonl");
  const userText = "This is a sufficiently long user message for fixture testing 12345";
  const asstText = "This is a sufficiently long assistant reply for fixture testing 67890";
  const lines = [
    JSON.stringify({ type: "user.message", id: "m1", data: { messageId: "m1", content: userText } }),
    JSON.stringify({ type: "assistant.message", id: "m2", data: { messageId: "m2", content: asstText } }),
    "{not json",
    JSON.stringify({ type: "user.message", id: "m3", data: { messageId: "m3", content: "short" } }),
    JSON.stringify({ type: "other.event", id: "m4", data: {} }),
  ];
  writeFileSync(eventsPath, lines.join("\n") + "\n");
  const snap = snapshotEnv(["SESSION_SEARCH_SESSION_STORE_DB", "SESSION_SEARCH_DATA_DB", "SESSION_SEARCH_STATE_DIR"]);
  process.env.SESSION_SEARCH_SESSION_STORE_DB = join(tmpRoot, "no-store.db");
  process.env.SESSION_SEARCH_DATA_DB = join(tmpRoot, "no-data.db");
  process.env.SESSION_SEARCH_STATE_DIR = stateDir;
  try {
    const res = readAllDocsWithFailures();
    check("read fixture events: collects 2 docs", res.docs.length === 2, `got=${res.docs.length}`);
    check("read fixture events: user doc present", res.docs.some((d) => d.text === userText));
    check("read fixture events: assistant doc present", res.docs.some((d) => d.text === asstText));
    check("read fixture events: 1 malformed failure", res.failures.length === 1, `got=${JSON.stringify(res.failures)}`);
    check(
      "read fixture events: badLines entry has source+reason",
      res.failures.length === 1 &&
        res.failures[0].source === eventsPath &&
        res.failures[0].reason === "1 malformed lines skipped",
      `got=${JSON.stringify(res.failures)}`
    );
  } finally {
    restoreEnv(snap);
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}
{
  const tmpRoot = mkdtempSync(join(tmpdir(), "ss-unit-read-db-"));
  const dbPath = join(tmpRoot, "store.db");
  const stateEmpty = join(tmpRoot, "state-empty");
  mkdirSync(stateEmpty, { recursive: true });
  const summaryText = "This is a long summary text that exceeds forty characters for testing";
  const turnUser = "This is a long user turn message exceeding forty characters 111";
  const turnAsst = "This is a long assistant turn reply exceeding forty characters 222";
  const setup = new DatabaseSync(dbPath);
  try {
    setup.exec("CREATE TABLE sessions (id TEXT, summary TEXT, created_at TEXT)");
    setup.exec("CREATE TABLE turns (session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT, timestamp TEXT)");
    setup.prepare("INSERT INTO sessions (id, summary, created_at) VALUES (?, ?, ?)").run("sess-db1", summaryText, "2024-01-02T03:04:05.000Z");
    setup.prepare("INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?, ?, ?, ?, ?)").run("sess-db1", 0, turnUser, turnAsst, "2024-01-02T04:00:00.000Z");
  } finally {
    setup.close();
  }
  const snap = snapshotEnv(["SESSION_SEARCH_SESSION_STORE_DB", "SESSION_SEARCH_DATA_DB", "SESSION_SEARCH_STATE_DIR"]);
  process.env.SESSION_SEARCH_SESSION_STORE_DB = dbPath;
  process.env.SESSION_SEARCH_DATA_DB = join(tmpRoot, "no-data.db");
  process.env.SESSION_SEARCH_STATE_DIR = stateEmpty;
  try {
    const res = readAllDocsWithFailures();
    check("read fixture db: collects 3 docs (summary+2 turns)", res.docs.length === 3, `got=${res.docs.length}`);
    check(
      "read fixture db: summary doc present",
      res.docs.some((d) => d.sourceType === "summary" && d.text === summaryText)
    );
    check(
      "read fixture db: turn user doc present",
      res.docs.some((d) => d.text === turnUser && d.sourceType === "user-message" && d.sourceId === "turn-0")
    );
    check(
      "read fixture db: turn assistant doc present",
      res.docs.some((d) => d.text === turnAsst && d.sourceType === "assistant-message" && d.sourceId === "turn-0")
    );
    check("read fixture db: no failures", res.failures.length === 0, `got=${JSON.stringify(res.failures)}`);
  } finally {
    restoreEnv(snap);
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}
{
  const tmpRoot = mkdtempSync(join(tmpdir(), "ss-unit-read-empty-"));
  const stateEmpty = join(tmpRoot, "state");
  mkdirSync(stateEmpty, { recursive: true });
  const snap = snapshotEnv(["SESSION_SEARCH_SESSION_STORE_DB", "SESSION_SEARCH_DATA_DB", "SESSION_SEARCH_STATE_DIR"]);
  process.env.SESSION_SEARCH_SESSION_STORE_DB = join(tmpRoot, "no-store.db");
  process.env.SESSION_SEARCH_DATA_DB = join(tmpRoot, "no-data.db");
  process.env.SESSION_SEARCH_STATE_DIR = stateEmpty;
  try {
    const res = readAllDocsWithFailures();
    check("read fixture empty dir: docs []", res.docs.length === 0, `got=${res.docs.length}`);
    check("read fixture empty dir: failures []", res.failures.length === 0, `got=${JSON.stringify(res.failures)}`);
  } finally {
    restoreEnv(snap);
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}
{
  // Red basis (code-evident): old readEventsDocs pushed unreadable failure for missing dir.
  const tmpRoot = mkdtempSync(join(tmpdir(), "ss-unit-read-absent-"));
  const snap = snapshotEnv(["SESSION_SEARCH_SESSION_STORE_DB", "SESSION_SEARCH_DATA_DB", "SESSION_SEARCH_STATE_DIR"]);
  process.env.SESSION_SEARCH_SESSION_STORE_DB = join(tmpRoot, "no-store.db");
  process.env.SESSION_SEARCH_DATA_DB = join(tmpRoot, "no-data.db");
  process.env.SESSION_SEARCH_STATE_DIR = join(tmpRoot, "no-such-state-dir");
  try {
    const res = readAllDocsWithFailures();
    check("read fixture absent state dir: docs []", res.docs.length === 0, `got=${res.docs.length}`);
    check("read fixture absent state dir: failures [] (silent)", res.failures.length === 0, `got=${JSON.stringify(res.failures)}`);
  } finally {
    restoreEnv(snap);
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}
{
  const tmpRoot = mkdtempSync(join(tmpdir(), "ss-unit-read-unopen-"));
  const dirAsDb = join(tmpRoot, "dir-as-db");
  mkdirSync(dirAsDb, { recursive: true });
  const stateEmpty = join(tmpRoot, "state-empty");
  mkdirSync(stateEmpty, { recursive: true });
  const snap = snapshotEnv(["SESSION_SEARCH_SESSION_STORE_DB", "SESSION_SEARCH_DATA_DB", "SESSION_SEARCH_STATE_DIR"]);
  process.env.SESSION_SEARCH_SESSION_STORE_DB = dirAsDb;
  process.env.SESSION_SEARCH_DATA_DB = join(tmpRoot, "no-data.db");
  process.env.SESSION_SEARCH_STATE_DIR = stateEmpty;
  try {
    const res = readAllDocsWithFailures();
    check("read fixture dir-as-db: docs []", res.docs.length === 0, `got=${res.docs.length}`);
    check(
      "read fixture dir-as-db: unopenable failure recorded",
      res.failures.some((f) => f.source === dirAsDb && f.reason.startsWith("unopenable:")),
      `got=${JSON.stringify(res.failures)}`
    );
  } finally {
    restoreEnv(snap);
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}
// Red basis (safe targeted check): ENOTDIR on readdirSync(file) must surface as unreadable; fails if catch removed.
{
  const tmpRoot = mkdtempSync(join(tmpdir(), "ss-unit-read-filestate-"));
  const fileAsState = join(tmpRoot, "file-as-state");
  writeFileSync(fileAsState, "not a directory");
  const snap = snapshotEnv(["SESSION_SEARCH_SESSION_STORE_DB", "SESSION_SEARCH_DATA_DB", "SESSION_SEARCH_STATE_DIR"]);
  process.env.SESSION_SEARCH_SESSION_STORE_DB = join(tmpRoot, "no-store.db");
  process.env.SESSION_SEARCH_DATA_DB = join(tmpRoot, "no-data.db");
  process.env.SESSION_SEARCH_STATE_DIR = fileAsState;
  try {
    const res = readAllDocsWithFailures();
    check("read fixture file-as-stateDir: docs []", res.docs.length === 0, `got=${res.docs.length}`);
    check(
      "read fixture file-as-stateDir: unreadable failure recorded",
      res.failures.some((f) => f.source === fileAsState && f.reason.startsWith("unreadable:")),
      `got=${JSON.stringify(res.failures)}`
    );
  } finally {
    restoreEnv(snap);
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------- save/load/locking (isolated via temp dir + INDEX_* env)
{
  const tmpIdx = mkdtempSync(join(tmpdir(), "ss-unit-idx-"));
  const tBin = join(tmpIdx, "index.bin");
  const tMeta = join(tmpIdx, "index.meta.json");
  const tLock = join(tmpIdx, "index.lock");
  const snapIdx = snapshotEnv(["SESSION_SEARCH_INDEX_BIN", "SESSION_SEARCH_INDEX_META", "SESSION_SEARCH_INDEX_LOCK"]);
  process.env.SESSION_SEARCH_INDEX_BIN = tBin;
  process.env.SESSION_SEARCH_INDEX_META = tMeta;
  process.env.SESSION_SEARCH_INDEX_LOCK = tLock;
  // Shadow real paths so test-local file checks also hit temp.
  const indexBinPath = tBin;
  const indexMetaPath = tMeta;
  const indexLockPath = tLock;

  const fixtureDims = 4;
  const fixtureChunks = [
    { sessionId: "S1", title: "t1", sourceType: "unit", date: null, text: "hello world fixture one" },
    { sessionId: "S2", title: "t2", sourceType: "unit", date: null, text: "hello world fixture two" },
  ];
  const fixtureVectors = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
  ];

  try {
    try {
      // -- validation (throw before touching files)
      try {
        saveIndex([], [], fixtureDims);
        check("saveIndex refuses empty chunks", false, "did not throw");
      } catch (err) {
        check(
          "saveIndex refuses empty chunks",
          /refusing to publish an empty index/.test(err.message),
          `message=${JSON.stringify(err.message)}`
        );
      }
      try {
        saveIndex(
          [
            [1, 2, 3, 4],
            [5, 6],
          ],
          fixtureChunks,
          fixtureDims
        );
        check("saveIndex refuses row with wrong dims", false, "did not throw");
      } catch (err) {
        check(
          "saveIndex refuses row with wrong dims",
          /row 1 has 2 dims/.test(err.message),
          `message=${JSON.stringify(err.message)}`
        );
      }
      try {
        saveIndex(fixtureVectors, fixtureChunks, 0);
        check("saveIndex refuses dims 0", false, "did not throw");
      } catch (err) {
        check(
          "saveIndex refuses dims 0",
          /invalid dims/.test(err.message),
          `message=${JSON.stringify(err.message)}`
        );
      }
      try {
        saveIndex(fixtureVectors, fixtureChunks, -1);
        check("saveIndex refuses negative dims", false, "did not throw");
      } catch (err) {
        check(
          "saveIndex refuses negative dims",
          /invalid dims/.test(err.message),
          `message=${JSON.stringify(err.message)}`
        );
      }
      // Red basis (prior demo): red-f5.mjs showed F5 TypeError for 2 vectors/3 chunks.
      try {
        saveIndex(
          [
            [1, 2, 3, 4],
            [5, 6, 7, 8],
          ],
          [
            ...fixtureChunks,
            { sessionId: "S3", title: "t3", sourceType: "unit", date: null, text: "hello world fixture three" },
          ],
          fixtureDims
        );
        check("saveIndex refuses 2 vectors for 3 chunks", false, "did not throw");
      } catch (err) {
        check(
          "saveIndex refuses 2 vectors for 3 chunks",
          /2 vectors for 3 chunks/.test(err.message),
          `message=${JSON.stringify(err.message)}`
        );
      }
      // Red basis (code-evident): old loop did vectors[i].length without null check, so TypeError.
      try {
        saveIndex(
          [
            [1, 2, 3, 4],
            undefined,
          ],
          fixtureChunks,
          fixtureDims
        );
        check("saveIndex refuses row with no vector", false, "did not throw");
      } catch (err) {
        check(
          "saveIndex refuses row with no vector",
          /row 1 has no vector/.test(err.message),
          `message=${JSON.stringify(err.message)}`
        );
      }

      // -- round-trip
      let roundTripErr = null;
      try {
        saveIndex(fixtureVectors, fixtureChunks, fixtureDims);
      } catch (err) {
        roundTripErr = err;
      }
      check("saveIndex valid tiny index saves without throw", roundTripErr === null, roundTripErr ? roundTripErr.message : "");
      check("saveIndex releases lock (index.lock absent after save)", !existsSync(indexLockPath));
      let loaded = null;
      let loadErr = null;
      try {
        loaded = loadIndex();
      } catch (err) {
        loadErr = err;
      }
      check("saveIndex round-trip loads without throw", loadErr === null, loadErr ? loadErr.message : "");
      check(
        "saveIndex round-trip preserves dims",
        loaded !== null && loaded.dims === 4,
        loaded ? `got=${loaded.dims}` : "no load"
      );
      check(
        "saveIndex round-trip preserves chunks",
        loaded !== null && JSON.stringify(loaded.chunks) === JSON.stringify(fixtureChunks),
        loaded ? `got=${JSON.stringify(loaded.chunks).slice(0, 160)}` : "no load"
      );
      check(
        "saveIndex round-trip preserves vectors",
        loaded !== null &&
          loaded.vectors.length === 8 &&
          Array.from(loaded.vectors).join(",") === "1,2,3,4,5,6,7,8",
        loaded ? `got=${Array.from(loaded.vectors).join(",")}` : "no load"
      );
      check(
        "saveIndex round-trip writes 40-char binSha1",
        loaded !== null &&
          typeof loaded.meta.binSha1 === "string" &&
          /^[0-9a-f]{40}$/.test(loaded.meta.binSha1),
        loaded ? `got=${JSON.stringify(loaded.meta.binSha1)}` : "no load"
      );
      if (loaded !== null) {
        const recomputed = sha1Of(readFileSync(indexBinPath));
        check(
          "saveIndex round-trip binSha1 matches file bytes",
          recomputed === loaded.meta.binSha1,
          `meta=${loaded.meta.binSha1} file=${recomputed}`
        );
      } else {
        check("saveIndex round-trip binSha1 matches file bytes", false, "no load");
      }

      // -- tamper detection
      const goodBin = readFileSync(indexBinPath);
      const tampered = Buffer.from(goodBin);
      tampered[0] = tampered[0] ^ 0xff;
      writeFileSync(indexBinPath, tampered);
      try {
        loadIndex();
        check("loadIndex throws /disagree/ on tampered bin", false, "did not throw");
      } catch (err) {
        check(
          "loadIndex throws /disagree/ on tampered bin",
          /disagree/.test(err.message),
          `message=${JSON.stringify(err.message)}`
        );
      }
      // Clean slate for lock tests.
      saveIndex(fixtureVectors, fixtureChunks, fixtureDims);

      // -- fresh lock blocks
      const beforeBinSha = sha1Of(readFileSync(indexBinPath));
      const beforeMetaSha = sha1Of(readFileSync(indexMetaPath));
      writeFileSync(indexLockPath, `test fresh ${Date.now()}\n`);
      try {
        try {
          saveIndex(fixtureVectors, fixtureChunks, fixtureDims);
          check("fresh lock blocks saveIndex", false, "did not throw");
        } catch (err) {
          check(
            "fresh lock blocks saveIndex",
            /another index build is in progress/.test(err.message),
            `message=${JSON.stringify(err.message)}`
          );
        }
        const afterBinSha = sha1Of(readFileSync(indexBinPath));
        const afterMetaSha = sha1Of(readFileSync(indexMetaPath));
        check(
          "fresh lock leaves index untouched",
          beforeBinSha === afterBinSha && beforeMetaSha === afterMetaSha,
          `bin ${beforeBinSha.slice(0, 8)}->${afterBinSha.slice(0, 8)} meta ${beforeMetaSha.slice(0, 8)}->${afterMetaSha.slice(0, 8)}`
        );
      } finally {
        try {
          unlinkSync(indexLockPath);
        } catch {
          // Already gone.
        }
      }

      // -- stale lock stolen
      writeFileSync(indexLockPath, "test stale\n");
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      utimesSync(indexLockPath, threeHoursAgo, threeHoursAgo);
      try {
        let staleErr = null;
        try {
          saveIndex(fixtureVectors, fixtureChunks, fixtureDims);
        } catch (err) {
          staleErr = err;
        }
        check(
          "stale lock (>2h) is stolen and save succeeds",
          staleErr === null,
          staleErr ? staleErr.message : ""
        );
        check("stale lock stolen: lock released", !existsSync(indexLockPath));
        let staleLoadOk = false;
        try {
          const reloaded = loadIndex();
          staleLoadOk =
            reloaded.dims === 4 && JSON.stringify(reloaded.chunks) === JSON.stringify(fixtureChunks);
        } catch {
          staleLoadOk = false;
        }
        check("stale lock stolen: index contains new save", staleLoadOk);
      } finally {
        try {
          unlinkSync(indexLockPath);
        } catch {
          // Already gone.
        }
      }

      // Red basis (code-evident): INDEX_* env did not exist pre-fix, so temp files would not exist.
      check(
        "saveIndex writes to temp paths via INDEX_* overrides",
        existsSync(indexBinPath) && existsSync(indexMetaPath),
        `bin=${existsSync(indexBinPath)} meta=${existsSync(indexMetaPath)}`
      );

      // Red basis (code-evident): modelFileIdentity/meta.modelIdentity did not exist pre-fix.
      {
        const tmpModel = mkdtempSync(join(tmpdir(), "ss-unit-model-"));
        const modelFile = join(tmpModel, "fake-model.gguf");
        writeFileSync(modelFile, "fake model bytes for testing");
        const st = statSync(modelFile);
        const expectedIdentity = `${st.size}:${Math.floor(st.mtimeMs)}`;
        const snapModel = snapshotEnv(["SESSION_SEARCH_MODEL_PATH"]);
        process.env.SESSION_SEARCH_MODEL_PATH = modelFile;
        try {
          saveIndex(fixtureVectors, fixtureChunks, fixtureDims);
          const withIdentity = loadIndex();
          check(
            "saveIndex persists meta.modelIdentity from model file",
            withIdentity !== null && withIdentity.meta.modelIdentity === expectedIdentity,
            withIdentity ? `got=${JSON.stringify(withIdentity.meta.modelIdentity)} want=${expectedIdentity}` : "no load"
          );
        } finally {
          restoreEnv(snapModel);
          try { rmSync(tmpModel, { recursive: true, force: true }); } catch {}
        }
      }
    } catch (unexpected) {
      check("save/lock block unexpected error", false, String((unexpected && unexpected.message) || unexpected));
    }
  } finally {
    restoreEnv(snapIdx);
    try { rmSync(tmpIdx, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------- modelFileIdentity (isolated via temp file + MODEL_PATH env)
// Red basis (code-evident): modelFileIdentity did not exist pre-fix.
{
  const tmpModel = mkdtempSync(join(tmpdir(), "ss-unit-ident-"));
  const modelFile = join(tmpModel, "fake-model.gguf");
  writeFileSync(modelFile, "fake model bytes for identity testing");
  const st = statSync(modelFile);
  const expected = `${st.size}:${Math.floor(st.mtimeMs)}`;
  const snap = snapshotEnv(["SESSION_SEARCH_MODEL_PATH"]);
  process.env.SESSION_SEARCH_MODEL_PATH = modelFile;
  try {
    const got = modelFileIdentity();
    check("modelFileIdentity matches size:mtime via statSync", got === expected, `got=${got} want=${expected}`);
  } finally {
    restoreEnv(snap);
    try { rmSync(tmpModel, { recursive: true, force: true }); } catch {}
  }
}
{
  const tmpModel = mkdtempSync(join(tmpdir(), "ss-unit-ident-miss-"));
  const missing = join(tmpModel, "no-such-model.gguf");
  const snap = snapshotEnv(["SESSION_SEARCH_MODEL_PATH"]);
  process.env.SESSION_SEARCH_MODEL_PATH = missing;
  try {
    const got = modelFileIdentity();
    check("modelFileIdentity null when model missing", got === null, `got=${JSON.stringify(got)}`);
  } finally {
    restoreEnv(snap);
    try { rmSync(tmpModel, { recursive: true, force: true }); } catch {}
  }
}

// Safety: real index must be unchanged (temp isolation, no backup/restore).
{
  const curBinSha = existsSync(indexBinPath) ? sha1Of(readFileSync(indexBinPath)) : null;
  const curMetaSha = existsSync(indexMetaPath) ? sha1Of(readFileSync(indexMetaPath)) : null;
  check("safety: real index.bin unchanged (temp isolation)", curBinSha === realBinSha0);
  check("safety: real index.meta.json unchanged (temp isolation)", curMetaSha === realMetaSha0);
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failing: ${failures.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("\nall tests passed");
}
process.exit(process.exitCode || 0);
