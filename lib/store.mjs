import { readFileSync, writeFileSync, existsSync, statSync, renameSync, openSync, closeSync, unlinkSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { indexBinPath, indexMetaPath, indexLockPath, modelName } from "./paths.mjs";

export function indexMtimeMs() {
  try {
    return statSync(indexBinPath).mtimeMs;
  } catch {
    return null;
  }
}

export function loadIndex() {
  if (!existsSync(indexBinPath) || !existsSync(indexMetaPath)) return null;
  const meta = JSON.parse(readFileSync(indexMetaPath, "utf8"));
  const buf = readFileSync(indexBinPath);
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

function acquireLock() {
  try {
    const fd = openSync(indexLockPath, "wx");
    writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    closeSync(fd);
    return;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  // Another publisher holds the lock. A build killed mid-publish leaves a
  // stale lock behind; steal it so scheduled reindexing never bricks.
  let stale = false;
  try {
    stale = Date.now() - statSync(indexLockPath).mtimeMs > LOCK_STALE_MS;
  } catch {
    stale = true; // lock vanished mid-check: treat as free
  }
  if (!stale) {
    throw new Error(
      `another index build is in progress (lock: ${indexLockPath})`
    );
  }
  try {
    unlinkSync(indexLockPath);
  } catch {
    // Lost the race to another publisher: fall through to the loud failure.
  }
  const fd = openSync(indexLockPath, "wx");
  writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
  closeSync(fd);
}

function releaseLock() {
  try {
    unlinkSync(indexLockPath);
  } catch {
    // Already gone (stolen or never acquired): nothing to release.
  }
}

export function assertSafeToPublish({ docsCount, failures, oldChunks }) {
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

export function saveIndex(vectors, chunks, dims) {
  if (chunks.length === 0) {
    throw new Error(
      "refusing to publish an empty index — abort the build instead of overwriting"
    );
  }
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new Error(`refusing to publish: invalid dims ${dims}`);
  }
  for (let i = 0; i < vectors.length; i++) {
    if (vectors[i].length !== dims) {
      throw new Error(
        `refusing to publish: row ${i} has ${vectors[i].length} dims, want ${dims} (model changed? full re-embed needed)`
      );
    }
  }
  acquireLock();
  // Per-process temp names: concurrent publishers never share a temp file,
  // so a rename only ever publishes bytes this process wrote.
  const tag = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const binTmp = `${indexBinPath}.tmp-${tag}`;
  const metaTmp = `${indexMetaPath}.tmp-${tag}`;
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
    renameSync(metaTmp, indexMetaPath);
    renameSync(binTmp, indexBinPath);
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
