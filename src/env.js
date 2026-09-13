import { readFile } from "node:fs/promises";

/**
 * Minimal .env loader — tries each path in order, parses the first one that
 * exists, and sets any KEY=VALUE it doesn't already find in process.env.
 * No dependency on `dotenv`; skips lines that are blank or start with `#`.
 */
export async function loadDotEnv(paths) {
  for (const path of paths) {
    let raw;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) process.env[key] = value;
    }
    return; // stop at the first .env found
  }
}
