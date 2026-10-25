import { existsSync } from "node:fs";
import { extRoot, modelName } from "../lib/paths.mjs";
import { readAllDocs } from "../lib/read.mjs";
import { chunkText, chunkKey, sha1 } from "../lib/chunk.mjs";
import { embedDocuments, disposeEmbedder } from "../lib/embed.mjs";
import { loadIndex, saveIndex } from "../lib/store.mjs";

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
  const docs = readAllDocs();
  console.log(`sources: ${docs.length} documents`);
  const chunks = buildChunks(docs);
  console.log(`chunks: ${chunks.length}`);

  let old = null;
  if (existsSync("index.meta.json")) {
    try {
      old = loadIndex();
      if (old.meta.model !== modelName) {
        console.log(
          `model changed (${old.meta.model} -> ${modelName}), full re-embed`
        );
        old = null;
      }
    } catch (err) {
      console.log(`old index unreadable, rebuilding: ${err.message}`);
    }
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
    console.log("nothing changed, index untouched");
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

  if (toEmbed.length > 0) {
    const fresh = await embedDocuments(toEmbed, (done, total) => {
      if (done % 25 === 0 || done === total)
        console.log(`embedded ${done}/${total}`);
    });
    fresh.forEach((v, j) => {
      vectors[toEmbedAt[j]] = v;
    });
    await disposeEmbedder();
  }

  const dims = vectors.length > 0 ? vectors[0].length : old ? old.dims : 0;
  if (vectors.length === 0) {
    console.log("no chunks to index, writing empty index");
    saveIndex([], [], dims);
    return;
  }
  saveIndex(vectors, chunks, dims);
  console.log(`wrote index: ${chunks.length} chunks, ${dims} dims`);
}

main().catch((err) => {
  console.error(`build failed: ${err.message}`);
  process.exitCode = 1;
});
