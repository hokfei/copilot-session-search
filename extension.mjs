import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";
import { extRoot, buildScriptPath } from "./lib/paths.mjs";
import { loadIndex, indexMtimeMs } from "./lib/store.mjs";
import { searchVectors, DEFAULT_LIMIT, MAX_LIMIT } from "./lib/search.mjs";

const execFileAsync = promisify(execFile);

let cached = null;
let cachedMtime = null;
let embedModule = null;

async function getIndex() {
  const mtime = indexMtimeMs();
  if (mtime === null) return null;
  if (!cached || cachedMtime !== mtime) {
    try {
      cached = loadIndex();
      cachedMtime = mtime;
    } catch (err) {
      dropCache();
      throw err;
    }
  }
  return cached;
}

function dropCache() {
  cached = null;
  cachedMtime = null;
}

async function findNode() {
  if (basename(process.execPath).toLowerCase().startsWith("node")) {
    return process.execPath;
  }
  const probe = process.platform === "win32" ? "where" : "which";
  const { stdout } = await execFileAsync(probe, ["node"]);
  const found = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  if (!found) throw new Error("node executable not found on PATH");
  return found;
}

async function getEmbedder() {
  if (!embedModule) embedModule = await import("./lib/embed.mjs");
  return embedModule;
}

function formatResults(results) {
  if (results.length === 0) return "No matching sessions found.";
  return results
    .map((r, i) => {
      const when = r.date || "unknown date";
      return `[${i + 1}] ${r.title} (${r.sourceType}, ${when}, score ${r.score.toFixed(3)})\n${r.snippet}`;
    })
    .join("\n\n---\n\n");
}

const session = await joinSession({
  tools: [
    {
      name: "search_sessions",
      description:
        "Semantic search over your own past Copilot sessions. Returns matching session titles, dates, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search past sessions for.",
          },
          limit: {
            type: "integer",
            description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
            minimum: 1,
            maximum: MAX_LIMIT,
          },
        },
        required: ["query"],
      },
      handler: async (args) => {
        const query = (args.query || "").trim();
        if (!query) return "Give a non-empty query to search sessions.";
        let index;
        try {
          index = await getIndex();
        } catch {
          return "The search index is unreadable right now (it may be rebuilding). Wait a moment and try again, or run reindex_sessions.";
        }
        if (!index) {
          return `No search index found. Run the build script once: node scripts/build-index.mjs inside ${extRoot} (or: npm run build there). Then call this tool again.`;
        }
        const { embedQuery } = await getEmbedder();
        const queryVec = await embedQuery(query);
        if (queryVec.length !== index.dims) {
          return `Index dims (${index.dims}) disagree with the model (${queryVec.length}). Rebuild the index with reindex_sessions.`;
        }
        const results = searchVectors(
          index.vectors,
          index.chunks,
          index.dims,
          queryVec,
          args.limit ?? DEFAULT_LIMIT
        );
        return formatResults(results);
      },
    },
    {
      name: "reindex_sessions",
      description:
        "Rebuild the session search index from current session stores, picking up new sessions.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        await session.log("Rebuilding session search index…", {
          ephemeral: true,
        });
        try {
          const nodeBin = await findNode();
          const { stdout } = await execFileAsync(
            nodeBin,
            [buildScriptPath],
            { cwd: extRoot, timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }
          );
          dropCache();
          const tail = stdout.trim().split("\n").slice(-5).join("\n");
          return `Reindex done. Index cache dropped.\n${tail}`;
        } catch (err) {
          return `Reindex failed: ${err.message}`;
        }
      },
    },
  ],
});

await session.log("session-search extension ready", { ephemeral: true });
