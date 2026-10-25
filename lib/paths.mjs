import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

export const extRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const copilotDir = join(homedir(), ".copilot");
export const sessionStoreDb = join(copilotDir, "session-store.db");
export const dataDb = join(copilotDir, "data.db");
export const sessionStateDir = join(copilotDir, "session-state");

export const modelPath =
  process.env.SESSION_SEARCH_MODEL_PATH ||
  join(extRoot, "models", "Qwen3-Embedding-0.6B-Q8_0.gguf");
export const modelName = basename(modelPath);
export const indexBinPath = join(extRoot, "index.bin");
export const indexMetaPath = join(extRoot, "index.meta.json");
export const lastRunPath = join(extRoot, "last-run.txt");
export const buildScriptPath = join(extRoot, "scripts", "build-index.mjs");
