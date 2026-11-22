import { existsSync } from "node:fs";
import { extRoot, modelName } from "../lib/paths.mjs";
import { readAllDocsWithFailures } from "../lib/read.mjs";
import { chunkText, chunkKey, sha1 } from "../lib/chunk.mjs";
import { embedDocuments, disposeEmbedder } from "../lib/embed.mjs";
import { loadIndex, saveIndex, assertSafeToPublish, modelFileIdentity, resolveIndexPaths, shouldFullReembed, hasMixedDims, formatDoneLine, partialWarningSuffix } from "../lib/store.mjs";

function buildChunks(docs) {
  const chunks = [];
  for (const doc of docs) {
    const parts = chunkText(doc.text);
    parts.forEach((text, i) => {
      chunks.push({
        key: chunkKey(doc.sessionId, doc.sourceType, doc.sourceId, i),
        hash: sha1(text),
        sessionId: doc.sessionId,
        title: doc.title,
        sourceType: doc.sourceType,
        date: doc.date,
        text,
      });
    });
  }
  return chunks;
}

async function main() {
  process.chdir(extRoot);
  const { docs, failures } = readAllDocsWithFailures();
  console.log(`sources: ${docs.length} documents`);
  const chunks = buildChunks(docs);
  console.log(`chunks: ${chunks.length}`);

  let old = null;
  if (existsSync(resolveIndexPaths().meta)) {
    try {
      old = loadIndex();
      if (old && old.meta.model !== modelName) {
        console.log(
          `model changed (${old.meta.model} -> ${modelName}), full re-embed`
        );
        old = null;
      }
      // Same-name weight swap: basename and dims can't see it, size+mtime can.
      // Runs before the unchanged fast-path below so a swap is never skipped.
      if (shouldFullReembed(old && old.meta, modelFileIdentity())) {
        console.log("model file changed (size/mtime), full re-embed");
        old = null;
      }
    } catch (err) {
      console.log(`old index unreadable, rebuilding: ${err.message}`);
    }
  }

  assertSafeToPublish({
    docsCount: docs.length,
    failures,
    oldChunks: old ? old.chunks.length : 0,
  });
  if (failures.length > 0) {
    console.log(`WARNING: partial index — ${failures.length} source problem(s):`);
    for (const f of failures) console.log(`WARNING:   ${f.source}: ${f.reason}`);
  }

  const oldByKey = new Map();
  if (old) {
    old.chunks.forEach((c, i) => {
      oldByKey.set(c.key, {
        hash: c.hash,
        vector: old.vectors.slice(i * old.dims, (i + 1) * old.dims),
      });
    });
  }

  const unchanged =
    old &&
    old.chunks.length === chunks.length &&
    chunks.every((c) => {
      const prev = oldByKey.get(c.key);
      return prev && prev.hash === c.hash;
    });
  if (unchanged) {
    console.log(`nothing changed, index untouched${partialWarningSuffix(failures)}`);
    return;
  }

  const vectors = new Array(chunks.length);
  const toEmbed = [];
  const toEmbedAt = [];
  for (let i = 0; i < chunks.length; i++) {
    const prev = oldByKey.get(chunks[i].key);
    if (prev && prev.hash === chunks[i].hash) {
      vectors[i] = Array.from(prev.vector);
    } else {
      toEmbed.push(chunks[i].text);
      toEmbedAt.push(i);
    }
  }
  console.log(
    `reuse: ${chunks.length - toEmbed.length}, embed: ${toEmbed.length}`
  );

  const onProgress = (done, total) => {
    if (done % 25 === 0 || done === total)
      console.log(`embedded ${done}/${total}`);
  };
  if (toEmbed.length > 0) {
    const fresh = await embedDocuments(toEmbed, onProgress);
    fresh.forEach((v, j) => {
      vectors[toEmbedAt[j]] = v;
    });
  }

  // Reused vectors can disagree with fresh ones when the model file was
  // swapped under the same name (the basename check above can't see that).
  // Uniformity is the real signal: mixed rows mean the model changed.
  if (hasMixedDims(vectors)) {
    console.log(
      "dims disagreement between reused and fresh vectors, full re-embed"
    );
    const fresh = await embedDocuments(
      chunks.map((c) => c.text),
      onProgress
    );
    fresh.forEach((v, j) => {
      vectors[j] = v;
    });
  }
  await disposeEmbedder();

  const dims = vectors[0].length;
  saveIndex(vectors, chunks, dims);
  console.log(formatDoneLine(chunks.length, dims, failures));
}

main().catch((err) => {
  console.error(`build failed: ${err.message}`);
  process.exitCode = 1;
});
