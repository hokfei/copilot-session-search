export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 15;

function dotProduct(vectors, dims, row, query) {
  let sum = 0;
  const off = row * dims;
  for (let i = 0; i < dims; i++) sum += vectors[off + i] * query[i];
  return sum;
}

export function searchVectors(vectors, chunks, dims, queryVec, limit = DEFAULT_LIMIT) {
  limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit) || DEFAULT_LIMIT));
  const scored = [];
  for (let row = 0; row < chunks.length; row++) {
    scored.push({ row, score: dotProduct(vectors, dims, row, queryVec) });
  }
  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, Math.max(limit, limit * 4));

  const picked = [];
  const perSession = new Map();
  for (const c of candidates) {
    if (picked.length >= limit) break;
    const sessionId = chunks[c.row].sessionId;
    const used = perSession.get(sessionId) || 0;
    if (used >= 2) continue;
    perSession.set(sessionId, used + 1);
    picked.push(c);
  }
  if (picked.length < limit) {
    const taken = new Set(picked.map((p) => p.row));
    for (const c of candidates) {
      if (picked.length >= limit) break;
      if (taken.has(c.row)) continue;
      picked.push(c);
    }
  }
  return picked.map(({ row, score }) => {
    const c = chunks[row];
    return {
      score,
      sessionId: c.sessionId,
      title: c.title,
      sourceType: c.sourceType,
      date: c.date,
      snippet: c.text,
    };
  });
}
