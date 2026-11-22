import { readFileSync, writeFileSync, existsSync, statSync, renameSync, openSync, closeSync, unlinkSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { basename } from "node:path";
import { indexBinPath, indexMetaPath, indexLockPath, modelName, defaultModelPath } from "./paths.mjs";

// Index locations, overridable for isolated testing (tests point these at a
// temp dir so the real index is never touched).
export function resolveIndexPaths() {
  return {
    bin: process.env.SESSION_SEARCH_INDEX_BIN || indexBinPath,
    meta: process.env.SESSION_SEARCH_INDEX_META || indexMetaPath,
    lock: process.env.SESSION_SEARCH_INDEX_LOCK || indexLockPath,
  };
}

// Identity of the embedding model file. Basename + dims can't detect a
// same-name weight swap; size + mtime can (cheaply — no 2.7GB hash).
// Limitation: a deliberate same-size mtime-preserving copy (cp -p) keeps the
// identity; accepted as a cheap-heuristic edge.
export function modelFileIdentity() {
  // Call-time env read is intentional: tests point the identity at fixtures.
  const live = process.env.SESSION_SEARCH_MODEL_PATH || defaultModelPath();
  try {
    const st = statSync(live);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return null; // missing model: embedding fails loudly later if needed
  }
}

export function indexMtimeMs() {
  try {
    return statSync(resolveIndexPaths().bin).mtimeMs;
  } catch {
    return null;
  }
}

export function loadIndex() {
  const paths = resolveIndexPaths();
  if (!existsSync(paths.bin) || !existsSync(paths.meta)) return null;
  const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
  const buf = readFileSync(paths.bin);
  const vectors = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / 4
  );
  if (vectors.length !== meta.chunks.length * meta.dims) {
    throw new Error(
      `Index files disagree: bin holds ${vectors.length / meta.dims} vectors but meta lists ${meta.chunks.length}. Rebuild the index.`
    );
  }
  if (meta.binSha1) {
    const actual = createHash("sha1").update(buf).digest("hex");
    if (actual !== meta.binSha1) {
      throw new Error(
        `Index files disagree: meta expects bin ${meta.binSha1} but found ${actual}. Rebuild the index.`
      );
    }
  }
  return { vectors, chunks: meta.chunks, dims: meta.dims, meta };
}

const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

function writeLockFile(lockPath) {
  const fd = openSync(lockPath, "wx");
  try {
    writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Best effort: the lock file itself is the signal.
    }
  }
}

function acquireLock() {
  const { lock } = resolveIndexPaths();
  try {
    writeLockFile(lock);
    return;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  // Another publisher holds the lock. A build killed mid-publish leaves a
  // stale lock behind; steal it so scheduled reindexing never bricks.
  let stale = false;
  try {
    stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    stale = true; // lock vanished mid-check: treat as free
  }
  if (!stale) {
    throw new Error(`another index publish is in progress (lock: ${lock})`);
  }
  try {
    unlinkSync(lock);
  } catch {
    // Lost the race to another publisher: fall through to the loud failure.
  }
  try {
    writeLockFile(lock);
  } catch (err) {
    if (err.code === "EEXIST") {
      throw new Error(`another index publish is in progress (lock: ${lock})`);
    }
    throw err;
  }
}

function releaseLock() {
  // No ownership check: saveIndex holds the lock for milliseconds (two
  // renames), so the 2h steal window never hits an active holder.
  try {
    unlinkSync(resolveIndexPaths().lock);
  } catch {
    // Already gone (stolen or never acquired): nothing to release.
  }
}

export function assertSafeToPublish({ docsCount = 0, failures = [], oldChunks = 0 } = {}) {
  if (docsCount > 0) return;
  const detail =
    failures.length > 0
      ? `: ${failures.map((f) => `${f.source} (${f.reason})`).join("; ")}`
      : "";
  if (oldChunks > 0) {
    throw new Error(
      `refusing to publish an empty index over ${oldChunks} existing chunks (no documents found)${detail} — index left untouched`
    );
  }
  throw new Error(
    `no documents found${detail} — nothing to publish, index left untouched`
  );
}

export function shouldFullReembed(oldMeta, currentIdentity) {
  if (!oldMeta) return false; // nothing to reuse: fresh build, not a re-embed
  // Legacy meta (no identity): provenance unverifiable, so re-embed once to
  // establish it. Stamping the new identity onto reused old vectors would
  // bless them permanently without ever checking the model.
  if (oldMeta.modelIdentity === undefined) return true;
  return oldMeta.modelIdentity !== currentIdentity;
}

export function hasMixedDims(vectors) {
  return new Set(vectors.map((v) => v.length)).size > 1;
}

export function partialWarningSuffix(failures) {
  if (failures.length === 0) return "";
  const what = failures.length === 1 ? "source problem" : "source problems";
  const shown = failures
    .slice(0, 3)
    .map((f) => `${basename(f.source)}: ${f.reason}`.slice(0, 100))
    .join("; ");
  const more = failures.length > 3 ? `; +${failures.length - 3} more` : "";
  return ` (WARNING: partial index, ${failures.length} ${what}: ${shown}${more})`;
}

export function formatDoneLine(chunkCount, dims, failures) {
  return `wrote index: ${chunkCount} chunks, ${dims} dims${partialWarningSuffix(failures)}`;
}

export function saveIndex(vectors, chunks, dims) {
  if (chunks.length === 0) {
    throw new Error(
      "refusing to publish an empty index — abort the build instead of overwriting"
    );
  }
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new Error(`refusing to publish: invalid dims ${dims}`);
  }
  if (vectors.length !== chunks.length) {
    throw new Error(
      `refusing to publish: ${vectors.length} vectors for ${chunks.length} chunks`
    );
  }
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    if (!v) {
      throw new Error(`refusing to publish: row ${i} has no vector`);
    }
    if (v.length !== dims) {
      throw new Error(
        `refusing to publish: row ${i} has ${v.length} dims, want ${dims} (model changed? full re-embed needed)`
      );
    }
  }
  acquireLock();
  const { bin, meta } = resolveIndexPaths();
  // Per-process temp names: concurrent publishers never share a temp file,
  // so a rename only ever publishes bytes this process wrote.
  const tag = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const binTmp = `${bin}.tmp-${tag}`;
  const metaTmp = `${meta}.tmp-${tag}`;
  try {
    const flat = new Float32Array(chunks.length * dims);
    for (let i = 0; i < chunks.length; i++) {
      flat.set(vectors[i], i * dims);
    }
    const binBytes = Buffer.from(flat.buffer);
    writeFileSync(binTmp, binBytes);
    const metaJson = JSON.stringify(
      {
        version: 1,
        dims,
        model: modelName,
        modelIdentity: modelFileIdentity(),
        binSha1: createHash("sha1").update(binBytes).digest("hex"),
        createdAt: new Date().toISOString(),
        chunks,
      },
      null,
      1
    );
    writeFileSync(metaTmp, metaJson);
    // Publish the pair: meta first, then bin. A reader between the two
    // renames sees new-meta/old-bin, which loadIndex rejects loudly via the
    // length check and bin hash — never silently wrong snippets.
    renameSync(metaTmp, meta);
    renameSync(binTmp, bin);
  } finally {
    releaseLock();
    for (const tmp of [binTmp, metaTmp]) {
      try {
        unlinkSync(tmp);
      } catch {
        // Published or never written: nothing to clean up.
      }
    }
  }
}
