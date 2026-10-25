import { readFileSync, writeFileSync, existsSync, statSync, renameSync } from "node:fs";
import { indexBinPath, indexMetaPath, modelName } from "./paths.mjs";

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
  return { vectors, chunks: meta.chunks, dims: meta.dims, meta };
}

export function saveIndex(vectors, chunks, dims) {
  const flat = new Float32Array(chunks.length * dims);
  for (let i = 0; i < chunks.length; i++) {
    flat.set(vectors[i], i * dims);
  }
  writeFileSync(indexBinPath + ".tmp", Buffer.from(flat.buffer));
  const metaJson = JSON.stringify(
    {
      version: 1,
      dims,
      model: modelName,
      createdAt: new Date().toISOString(),
      chunks,
    },
    null,
    1
  );
  writeFileSync(indexMetaPath + ".tmp", metaJson);
  // Publish atomically: a reader between the two renames sees either the
  // fully-old or fully-new pair, never a mixed one. Meta first so a crash
  // leaves old-meta/new-bin, which loadIndex's length check rejects loudly
  // instead of silently serving wrong snippets.
  renameSync(indexMetaPath + ".tmp", indexMetaPath);
  renameSync(indexBinPath + ".tmp", indexBinPath);
}
