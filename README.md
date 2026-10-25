# session-search

Local, private semantic search over your own past Copilot sessions, as a
GitHub Copilot app extension. Everything runs on your machine: no network at
query time, no API keys.

## How it works

```
session stores ──read──▶ docs ──chunk──▶ embed each ──▶ index.bin + index.meta.json
(read-only)        (1500 chars,   (Qwen3-Embedding-0.6B,
                    200 overlap)   1024 dims, local GGUF)

query ──embed──▶ dot product over all vectors ──▶ top limit*4 ──▶ max 2 per session
```

Sources read (all read-only, rows under 40 chars skipped):

- `~/.copilot/session-state/*/events.jsonl` — your and the assistant's messages
- `~/.copilot/session-store.db` — turns and summaries, when present
- `~/.copilot/data.db` — session titles and dates

## Setup

Requires Node 22.5+ (uses `node:sqlite`).

```bash
cd ~/.copilot/extensions/session-search

# 1. Install (downloads prebuilt llama.cpp binaries, no compiler needed)
npm install
node ./node_modules/node-llama-cpp/dist/cli/cli.js postinstall

# 2. Get the embedding model (~640 MB)
curl -L -o models/Qwen3-Embedding-0.6B-Q8_0.gguf \
  https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf
```

PowerShell:

```powershell
Invoke-WebRequest -Uri "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf" `
  -OutFile "models\Qwen3-Embedding-0.6B-Q8_0.gguf"
```

Or point `SESSION_SEARCH_MODEL_PATH` at a model you already have.

```bash
# 3. Build the index
npm run build

# 4. Restart the Copilot app so it loads the extension
```

## Tools

| Tool | Purpose |
| ---- | ------- |
| `search_sessions` | Search past sessions by meaning (`query`, `limit` default 5, max 15). |
| `reindex_sessions` | Rebuild the index from current stores and drop the in-memory cache. |

## Reindexing

- Ask the assistant to call `reindex_sessions`, or run `npm run build` here.
- Indexing is incremental: unchanged chunks reuse their stored vectors, and if
  nothing changed no files are written.
- For a daily refresh: `npm run schedule` registers an OS scheduled task
  (Windows Task Scheduler, or prints a cron line elsewhere) that runs
  `scripts/daily-reindex.mjs`. A `last-run.txt` local-date stamp guarantees it
  never runs twice in one day.

## Tests

```bash
npm test
```

Runs generic self-consistency checks against your own index (result shape,
score ordering, per-session cap, limit clamp, chunk round-trip).

## Layout

```
extension.mjs          entry point, registers the two tools
lib/paths.mjs          path resolution (relative, no hardcoded usernames)
lib/read.mjs           read-only session store readers
lib/chunk.mjs          sliding-window chunking + keying/hashing
lib/embed.mjs          local embedding (lazy-loaded, L2-normalized)
lib/store.mjs          Float32 bin + JSON meta persistence
lib/search.mjs         brute-force dot-product search + per-session cap
scripts/build-index.mjs    incremental index builder
scripts/test-search.mjs    self-consistency tests
scripts/daily-reindex.mjs  once-a-day guard + rebuild
scripts/schedule-daily.mjs OS scheduler registration
index.bin              vectors (generated, gitignored)
index.meta.json        chunk metadata (generated, gitignored)
```

## License

MIT
