import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { sessionStoreDb, dataDb, sessionStateDir } from "./paths.mjs";

const MIN_CHARS = 40;

// Source locations, overridable for isolated testing.
function resolveSourcePaths() {
  return {
    sessionStore: process.env.SESSION_SEARCH_SESSION_STORE_DB || sessionStoreDb,
    data: process.env.SESSION_SEARCH_DATA_DB || dataDb,
    stateDir: process.env.SESSION_SEARCH_STATE_DIR || sessionStateDir,
  };
}

function openReadOnly(path, failures) {
  try {
    if (!existsSync(path)) return null; // absent source, not a failure
    return new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    failures.push({ source: path, reason: `unopenable: ${err.message}` });
    return null;
  }
}

function tableExists(db, name) {
  try {
    const row = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = ?")
      .get(name);
    return !!row;
  } catch {
    return false;
  }
}

function dataDbTitles(failures, paths) {
  const titles = new Map();
  const db = openReadOnly(paths.data, failures);
  if (!db) return titles;
  try {
    if (!tableExists(db, "sessions")) return titles;
    for (const row of db
      .prepare("SELECT id, title, created_at FROM sessions")
      .all()) {
      titles.set(row.id, {
        title: row.title || "Untitled session",
        date: row.created_at || null,
      });
    }
  } finally {
    db.close();
  }
  return titles;
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b.text === "string" ? b.text : ""))
      .join("\n");
  }
  return "";
}

function readEventsDocs(titles, failures, paths) {
  const docs = [];
  if (!existsSync(paths.stateDir)) return docs; // absent source, not a failure
  let dirs = [];
  try {
    dirs = readdirSync(paths.stateDir, { withFileTypes: true });
  } catch (err) {
    failures.push({ source: paths.stateDir, reason: `unreadable: ${err.message}` });
    return docs;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.name.startsWith(".")) continue;
    const sessionId = dir.name;
    const eventsPath = join(paths.stateDir, sessionId, "events.jsonl");
    if (!existsSync(eventsPath)) continue;
    const info = titles.get(sessionId) || {};
    let fallbackDate = null;
    try {
      fallbackDate = statSync(eventsPath).mtime.toISOString();
    } catch {
      fallbackDate = null;
    }
    const title = info.title || "Untitled session";
    const date = info.date || fallbackDate;
    let raw;
    try {
      raw = readFileSync(eventsPath, "utf8");
    } catch (err) {
      failures.push({ source: eventsPath, reason: `unreadable: ${err.message}` });
      continue;
    }
    let badLines = 0;
    const lines = raw.split("\n");
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // A truncated final line (crash mid-append) is expected noise, not a
        // corrupt source: skip it silently so the warning stays meaningful.
        const isTruncatedTail = li === lines.length - 1 && !raw.endsWith("\n");
        if (!isTruncatedTail) badLines++;
        continue;
      }
      let sourceType = null;
      if (event.type === "user.message") sourceType = "user-message";
      else if (event.type === "assistant.message")
        sourceType = "assistant-message";
      if (!sourceType) continue;
      const text = messageText(event.data && event.data.content).trim();
      if (text.length < MIN_CHARS) continue;
      const sourceId =
        (event.data && event.data.messageId) || event.id || "unknown";
      docs.push({ sessionId, title, date, sourceType, sourceId, text });
    }
    if (badLines > 0) {
      failures.push({ source: eventsPath, reason: `${badLines} malformed line${badLines === 1 ? "" : "s"} skipped` });
    }
  }
  return docs;
}

function readSessionStoreDocs(failures, paths) {
  const docs = [];
  const db = openReadOnly(paths.sessionStore, failures);
  if (!db) return docs;
  try {
    const summaries = new Map();
    if (tableExists(db, "sessions")) {
      for (const row of db
        .prepare("SELECT id, summary, created_at FROM sessions")
        .all()) {
        summaries.set(row.id, {
          title: row.summary || "Untitled session",
          date: row.created_at || null,
        });
        const text = (row.summary || "").trim();
        if (text.length >= MIN_CHARS) {
          docs.push({
            sessionId: row.id,
            title: text.slice(0, 120),
            date: row.created_at || null,
            sourceType: "summary",
            sourceId: "summary",
            text,
          });
        }
      }
    } else {
      failures.push({ source: paths.sessionStore, reason: "missing table 'sessions'" });
    }
    if (tableExists(db, "turns")) {
      for (const row of db
        .prepare(
          "SELECT session_id, turn_index, user_message, assistant_response, timestamp FROM turns"
        )
        .all()) {
        const info = summaries.get(row.session_id) || {};
        const title = info.title || "Untitled session";
        const date = row.timestamp || info.date || null;
        for (const [sourceType, text] of [
          ["user-message", row.user_message],
          ["assistant-message", row.assistant_response],
        ]) {
          const clean = (text || "").trim();
          if (clean.length < MIN_CHARS) continue;
          docs.push({
            sessionId: row.session_id,
            title,
            date,
            sourceType,
            sourceId: `turn-${row.turn_index}`,
            text: clean,
          });
        }
      }
    } else {
      failures.push({ source: paths.sessionStore, reason: "missing table 'turns'" });
    }
  } finally {
    db.close();
  }
  return docs;
}

export function readAllDocsWithFailures() {
  const failures = [];
  const paths = resolveSourcePaths();
  const titles = dataDbTitles(failures, paths);
  const docs = [...readSessionStoreDocs(failures, paths), ...readEventsDocs(titles, failures, paths)];
  const seen = new Set();
  const unique = [];
  for (const doc of docs) {
    const digest = createHash("sha1").update(doc.text, "utf8").digest("hex");
    const dedupeKey = `${doc.sessionId}\n${digest}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    unique.push(doc);
  }
  return { docs: unique, failures };
}
