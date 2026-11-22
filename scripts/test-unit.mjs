import { searchVectors } from "../lib/search.mjs";
import { saveIndex, loadIndex, assertSafeToPublish } from "../lib/store.mjs";
import { readAllDocsWithFailures, readAllDocs } from "../lib/read.mjs";
import { extRoot, indexBinPath, indexMetaPath, indexLockPath } from "../lib/paths.mjs";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
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

// ---------------------------------------------------------------- read shapes (live local sources, shapes only)
{
  let res = null;
  let threw = null;
  try {
    res = readAllDocsWithFailures();
  } catch (err) {
    threw = err;
  }
  check("readAllDocsWithFailures runs without throw", threw === null, threw ? threw.message : "");
  const docs = res ? res.docs : null;
  const fails = res ? res.failures : null;
  check("readAllDocsWithFailures returns docs array", Array.isArray(docs));
  check("readAllDocsWithFailures returns failures array", Array.isArray(fails));
  check(
    "readAllDocsWithFailures every failure has string source+reason",
    Array.isArray(fails) && fails.every((f) => typeof f.source === "string" && typeof f.reason === "string"),
    Array.isArray(fails) ? `failures=${fails.length}` : "no failures array"
  );
  check(
    "readAllDocsWithFailures docs have string sessionId+text",
    Array.isArray(docs) && docs.every((d) => typeof d.sessionId === "string" && typeof d.text === "string"),
    Array.isArray(docs) ? `docs=${docs.length}` : "no docs array"
  );
}
{
  let docs = null;
  let threw = null;
  try {
    docs = readAllDocs();
  } catch (err) {
    threw = err;
  }
  check("readAllDocs runs without throw", threw === null, threw ? threw.message : "");
  check("readAllDocs returns plain docs array", Array.isArray(docs));
}

// ---------------------------------------------------------------- save/load/locking (touches real index: backup+restore)
{
  const haveBin = existsSync(indexBinPath);
  const haveMeta = existsSync(indexMetaPath);
  const origBin = haveBin ? readFileSync(indexBinPath) : null;
  const origMeta = haveMeta ? readFileSync(indexMetaPath) : null;
  const origBinSha = origBin ? sha1Of(origBin) : null;
  const origMetaSha = origMeta ? sha1Of(origMeta) : null;
  // Deterministic start: no build should run during tests.
  try {
    unlinkSync(indexLockPath);
  } catch {
    // Absent: nothing to clean.
  }

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
    } catch (unexpected) {
      check("save/lock block unexpected error", false, String((unexpected && unexpected.message) || unexpected));
    }
  } finally {
    // Restore the user's real index even on failure, then verify byte-identical.
    try {
      if (origBin) writeFileSync(indexBinPath, origBin);
      else {
        try {
          unlinkSync(indexBinPath);
        } catch {
          // Never existed.
        }
      }
      if (origMeta) writeFileSync(indexMetaPath, origMeta);
      else {
        try {
          unlinkSync(indexMetaPath);
        } catch {
          // Never existed.
        }
      }
      let ok = true;
      let detail = "";
      if (origBin) {
        const cur = sha1Of(readFileSync(indexBinPath));
        if (cur !== origBinSha) {
          ok = false;
          detail += `bin ${cur.slice(0, 8)}!=${origBinSha.slice(0, 8)} `;
        }
      }
      if (origMeta) {
        const curM = sha1Of(readFileSync(indexMetaPath));
        if (curM !== origMetaSha) {
          ok = false;
          detail += `meta ${curM.slice(0, 8)}!=${origMetaSha.slice(0, 8)}`;
        }
      }
      check("real index restored byte-identical", ok, detail.trim());
      try {
        unlinkSync(indexLockPath);
      } catch {
        // Released: nothing to clean.
      }
    } catch (restoreErr) {
      check("real index restored byte-identical", false, `restore failed: ${restoreErr.message}`);
      try {
        unlinkSync(indexLockPath);
      } catch {
        // Best effort.
      }
    }
  }
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failing: ${failures.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("\nall tests passed");
}
process.exit(process.exitCode || 0);
