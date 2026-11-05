// Self-test for shadow-search (node --test test/shadow-search.test.mjs)
//
// Directories are always built from temp dirs: the module's premise is that the
// caller supplies the directory, so the tests depend on no real local path.
//
// Since 1.0.6 backups are split per session (`sessionDir(root, key)`); these
// tests cover both forms: passing the session directory directly, and passing
// root + sessionKey so the module locates it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchShadow } from "../shadow-search.js";
import { shadowFileBody, sessionDir } from "../shadow.js";

/**
 * Build a shadow root split per session; returns { root, sessionDirOf, write }.
 * write(sessionKey, name, body) writes into that session's directory.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "spine-search-"));
  const sessionDirOf = (key) => sessionDir(root, key);
  const write = (sessionKey, name, body) => {
    const dir = sessionDirOf(sessionKey);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), shadowFileBody(sessionKey, body), "utf8");
  };
  return { root, sessionDirOf, write };
}

test("search by session directory: hits return file, session key and 1-based line number", () => {
  const { root, sessionDirOf, write } = fixture();
  write("sess-a", "cut-1-aaaaaaaa.txt", "first line\ncommit 99f51d0 pushed\nthird line");
  const result = searchShadow({ dir: sessionDirOf("sess-a"), pattern: "99f51d0" });
  assert.equal(result.scanned, 1);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].sessionKey, "sess-a");
  assert.equal(result.matches[0].line, 3, "the first line is the # spine-session header, so the hit is on line 3");
});

test("root + sessionKey form: resolves only that session directory", () => {
  const { root, write } = fixture();
  write("sess-a", "cut-2-bbbbbbbb.txt", "want-this-line");
  write("sess-b", "cut-3-cccccccc.txt", "want-this-line");
  const result = searchShadow({ root, sessionKey: "sess-a", pattern: "want-this-line" });
  assert.equal(result.directory, sessionDir(root, "sess-a"));
  assert.equal(result.matches.length, 1, "identical content in another session must not be found");
  assert.equal(result.matches[0].sessionKey, "sess-a");
});

test("the session header itself does not participate in matching", () => {
  const { sessionDirOf, write } = fixture();
  write("want-this-session-key", "cut-4-dddddddd.txt", "the body has no keyword");
  const result = searchShadow({ dir: sessionDirOf("want-this-session-key"), pattern: "want-this-session-key" });
  assert.equal(result.matches.length, 0, "the # spine-session first line is metadata and must not match");
});

test("regex mode and ignore case", () => {
  const { sessionDirOf, write } = fixture();
  write("sess-a", "cut-5-eeeeeeee.txt", "Commit 99F51D0\nanother commit abc1234");
  const byRegex = searchShadow({ dir: sessionDirOf("sess-a"), pattern: "commit [0-9a-f]{7}", regex: true, ignoreCase: true });
  assert.equal(byRegex.matches.length, 2);
  const byIgnoreCase = searchShadow({ dir: sessionDirOf("sess-a"), pattern: "99f51d0", ignoreCase: true });
  assert.equal(byIgnoreCase.matches.length, 1);
});

test("limit truncation sets truncated true and never returns extra hits", () => {
  const { sessionDirOf, write } = fixture();
  write("sess-a", "cut-6-ffffffff.txt", Array.from({ length: 10 }, () => "needle").join("\n"));
  const result = searchShadow({ dir: sessionDirOf("sess-a"), pattern: "needle", limit: 3 });
  assert.equal(result.matches.length, 3);
  assert.equal(result.truncated, true);
});

test("oversize files are skipped and counted, without affecting other files", () => {
  const { sessionDirOf, write } = fixture();
  write("sess-a", "cut-7-11111111.txt", "x".repeat(2048) + "needle");
  write("sess-a", "cut-8-22222222.txt", "needle");
  const result = searchShadow({ dir: sessionDirOf("sess-a"), pattern: "needle", maxFileBytes: 1024 });
  assert.equal(result.skipped, 1);
  assert.equal(result.scanned, 1);
  assert.equal(result.matches.length, 1);
  assert.match(result.matches[0].file, /cut-8/);
});

test("no recursion into subdirectories: only the given level is read", () => {
  const { root, sessionDirOf, write } = fixture();
  write("sess-a", "cut-9-33333333.txt", "needle");
  // Nest a subdirectory inside sess-a that also holds a file with the same content
  const nested = join(sessionDirOf("sess-a"), "nested");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "deep.txt"), shadowFileBody("sess-a", "needle"), "utf8");
  const result = searchShadow({ dir: sessionDirOf("sess-a"), pattern: "needle" });
  assert.equal(result.scanned, 1, "files in a subdirectory must not be read");
  assert.ok(!result.matches.some((m) => m.file.includes("nested")));
  assert.equal(result.directory, sessionDirOf("sess-a"), "the root argument only resolves the directory; it does not participate in the scan");
  void root;
});

test("a missing directory returns an empty result instead of throwing", () => {
  const { root } = fixture();
  const result = searchShadow({ root, sessionKey: "no-such-session", pattern: "x" });
  assert.deepEqual({ scanned: result.scanned, matches: result.matches.length }, { scanned: 0, matches: 0 });
});

test("a missing directory argument or pattern throws TypeError", () => {
  assert.throws(() => searchShadow({ pattern: "x" }), /either dir .* or root \+ sessionKey/);
  assert.throws(() => searchShadow({ root: "/tmp" }), /either dir .* or root \+ sessionKey/, "root alone must not work: that would mean scanning every session");
  assert.throws(() => searchShadow({ dir: "/tmp" }), /pattern is required/);
});
