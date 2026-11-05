// Keyword lookup inside a spine session's backup directory.
//
// Background: compaction moves long raw text out of the context and into the
// shadow directory, leaving only a summary behind. Summaries easily lose exact
// coordinates (file paths, short commit hashes, argument names), and today the
// only way to get them back is hand-typed grep in an external tool — but the
// directory layout and file naming are the plugin's own convention, so an
// external tool can only guess.
//
// Directory convention (since 1.0.6): backups are split into per-session
// directories; `sessionDir(root, key)` returns one session's directory.
// This module reads **only the one directory passed in**: no recursion, no
// crossing sessions, no path derivation. Callers that need "current session"
// semantics pass `root` + `sessionKey`, and this module calls `sessionDir`.
//
// Design stance (low coupling):
//   · directories always come from the caller (`dir`, or `root` + `sessionKey`)
//   · file recognition reuses this package's `listPluginShadows`: which files
//     count as backups and how they are named stays the plugin's business
//     (this module does not invent a second filter)
//   · the return value is plain data: no handles, no environment reads, no
//     global state

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listPluginShadows, sessionDir } from "./shadow.js";

/** Per-file default cap: larger files are skipped so a few hundred MB is never read into memory at once. */
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Default maximum number of hits to return. */
const DEFAULT_LIMIT = 50;
/** A backup file starts with `# spine-session <key>`: metadata that does not take part in matching. */
const SESSION_HEADER = /^# spine-session (\S+)\s*$/;

/**
 * Search text inside one session backup directory.
 *
 * There are only two ways to supply the directory; pick one:
 *   · `dir` — the session backup directory itself (for example the result of `sessionDir(shadowRoot, key)`)
 *   · `root` + `sessionKey` — the shadow root and session key; this module uses `sessionDir` to locate that session's directory
 * Either way it scans **only that one directory**: no subdirectories, no parent directory, no other sessions.
 *
 * @param {object} options options object
 * @param {string} [options.dir] session backup directory (either this or root+sessionKey)
 * @param {string} [options.root] shadow root directory (used with sessionKey)
 * @param {string} [options.sessionKey] session key (used with root)
 * @param {string} options.pattern keyword; interpreted as a regular expression when `regex: true`
 * @param {boolean} [options.regex=false] treat pattern as a regular expression
 * @param {boolean} [options.ignoreCase=false] ignore case
 * @param {number} [options.limit=50] maximum number of hits to return
 * @param {number} [options.maxFileBytes=8388608] per-file size cap; larger files are skipped
 * @returns {{directory: string, scanned: number, skipped: number, matchedFiles: number, truncated: boolean, matches: Array<{file: string, sessionKey: string, line: number, text: string}>}}
 * @throws {TypeError} when the directory argument or pattern is missing
 */
export function searchShadow(options = {}) {
  const directory = resolveTargetDirectory(options);
  const pattern = options.pattern;
  if (typeof pattern !== "string" || pattern === "") {
    throw new TypeError("searchShadow: pattern is required (a keyword, or a regular expression when regex is true)");
  }
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_LIMIT;
  const maxFileBytes = Number.isFinite(options.maxFileBytes) && options.maxFileBytes > 0
    ? Math.floor(options.maxFileBytes)
    : DEFAULT_MAX_FILE_BYTES;
  const matcher = options.regex === true
    ? new RegExp(pattern, options.ignoreCase === true ? "i" : "")
    : null;
  const needle = options.ignoreCase === true ? pattern.toLowerCase() : pattern;

  const matches = [];
  let scanned = 0;
  let skipped = 0;
  let matchedFiles = 0;
  let truncated = false;

  // Only this level is listed: listPluginShadows is itself one readdir that
  // keeps only regular files matching the naming scheme, so it cannot recurse
  // into other session directories.
  for (const file of listPluginShadows(directory)) {
    if (file.size > maxFileBytes) {
      skipped += 1;
      continue;
    }
    let text;
    try {
      text = readFileSync(file.path, "utf8");
    } catch {
      skipped += 1;
      continue;
    }
    scanned += 1;
    let hitThisFile = false;
    const lines = text.split("\n");
    const headerMatch = SESSION_HEADER.exec(lines[0] ?? "");
    const sessionKey = headerMatch === null ? file.sessionKey : headerMatch[1];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (SESSION_HEADER.test(line)) continue;
      const hit = matcher === null
        ? (options.ignoreCase === true ? line.toLowerCase().includes(needle) : line.includes(needle))
        : matcher.test(line);
      if (!hit) continue;
      hitThisFile = true;
      matches.push({
        file: file.path,
        sessionKey,
        line: index + 1,
        text: line.length > 400 ? `${line.slice(0, 400)}…` : line,
      });
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
    }
    if (hitThisFile) matchedFiles += 1;
    if (truncated) break;
  }

  return { directory, scanned, skipped, matchedFiles, truncated, matches };
}

/**
 * Resolve "the one directory to scan".
 *
 * Deliberately does not accept "root only": that would let callers think they
 * are searching every session, while the real need is always one session.
 *
 * @param {object} options searchShadow's input
 * @returns {string} absolute path of the session backup directory
 * @throws {TypeError} when no usable directory argument is given
 */
function resolveTargetDirectory(options) {
  if (typeof options.dir === "string" && options.dir !== "") return resolve(options.dir);
  if (typeof options.root === "string" && options.root !== "" && typeof options.sessionKey === "string" && options.sessionKey !== "") {
    return resolve(sessionDir(options.root, options.sessionKey));
  }
  throw new TypeError(
    "searchShadow: pass either dir (a session backup directory) or root + sessionKey; "
    + "searching a whole shadow root is not supported on purpose",
  );
}
