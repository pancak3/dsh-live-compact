import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitEvidence,
  backupClaimOk,
  withoutFullBackupClaim,
  backgroundJobId,
  buildCard,
  chooseKeptSpan,
  collectJobs,
  demoteEvidence,
  evidenceLines,
  jobCardLines,
  jobCutDecision,
  readResultLabel,
  toolEvidenceLine,
} from "../plan.js";
import { captureToolResult, contentHash, pointerFor, rawExcerptText, rawName, restoreToolText, runPruneAfterCapture, verifiedIds, verifiedRaw } from "../raw.js";
import { isPluginShadowName, rotateShadow } from "../shadow.js";

const phrases = ["committed and pushed", "pushed", "released v1.2", "all done", "published ./dist/plugin.tgz"];
for (const phrase of phrases) {
  const card = buildCard(phrase, "", [{ role: "assistant", text: phrase }]);
  assert.equal(card.hardLines.length, 0, phrase);
  assert.equal(card.text.includes(phrase), false, phrase);
  assert.equal(card.text.includes("published"), false);
  assert.equal(card.text.includes("pushed"), false);
}

const pushed = buildCard("", "", [{
  role: "tool",
  text: "rejected\n[exit code: 1]",
  isError: true,
  command: "git push origin main",
  name: "bash",
  toolCallId: "call-push",
  turn: 5,
}]);
assert.equal(pushed.text.includes("pushed"), false);
assert.equal(pushed.text.includes("Turn 5 `git push origin main` failed [call-push]"), true);
assert.equal(pushed.text.includes("exited 0"), false);

const started = "started background job bash-9\n";
assert.equal(toolEvidenceLine({
  role: "tool",
  text: started,
  command: "git push origin main",
  toolCallId: "call-bg",
  turn: 3,
}), "");
assert.equal(backgroundJobId("[still running after 1000ms; moved to background job bash-9]"), "bash-9");

assert.equal(demoteEvidence("Turn 1 `git push` exited 0 [missing]", new Set(["call-real"])), "");
assert.deepEqual(admitEvidence(["Turn 1 `git status` exited 0 [missing]"], new Set()), []);

const keptRound = buildCard("", "", [
  { role: "tool", text: "ok\n[exit code: 0]", command: "git commit -m x", toolCallId: "keep-me", turn: 8, inCut: false },
  { role: "tool", text: "ok\n[exit code: 0]", command: "git status", toolCallId: "cut-me", turn: 4 },
]);
assert.equal(keptRound.text.includes("keep-me"), false);
assert.equal(keptRound.text.includes("git commit"), false);
assert.equal(keptRound.text.includes("Turn 4 `git status` exited 0 [cut-me]"), true);
assert.equal(evidenceLines([{ role: "tool", text: "ok", toolCallId: "keep-me", command: "git commit", inCut: false }]).length, 0);

const jobs = collectJobs([
  { type: "turn/start", data: { turn: 3 } },
  { type: "tool/call", data: { turn: 3, callId: "call-bg", name: "bash", arguments: JSON.stringify({ command: "npm test" }) } },
  { type: "job/registered", data: { jobId: "bash-9", label: "npm test", toolCall: { callId: "call-bg" } } },
  { type: "tool/result", data: { turn: 3, message: { role: "tool", toolCallId: "call-bg", content: started } } },
  { type: "turn/start", data: { turn: 7 } },
  { type: "tool/call", data: { turn: 7, callId: "call-kill", name: "job_kill", arguments: JSON.stringify({ job_id: "bash-9" }) } },
  { type: "tool/result", data: { turn: 7, message: { role: "tool", toolCallId: "call-kill", content: "killed" } } },
]);
assert.equal(jobs[0].open, false);
assert.equal(jobs[0].status, "killed");
assert.equal(jobCardLines(jobs).some((line) => line.includes("still open")), false);
assert.equal(jobCardLines(jobs).some((line) => line.includes("ended in turn 7")), true);
const failedKill = collectJobs([
  { type: "job/registered", data: { turn: 2, jobId: "bash-k", label: "serve", toolCall: { callId: "call-k" } } },
  { type: "tool/call", data: { turn: 4, callId: "call-kill-fail", name: "job_kill", arguments: JSON.stringify({ job_id: "bash-k" }) } },
  { type: "tool/result", data: { turn: 4, message: { role: "tool", toolCallId: "call-kill-fail", content: "nope\n[exit code: 1]" } } },
]);
assert.equal(failedKill[0].open, true);
assert.equal(jobCardLines(failedKill).some((line) => line.includes("still open at cut time")), true);
const flaggedKill = collectJobs([
  { type: "job/registered", data: { turn: 2, jobId: "bash-flag", label: "serve", toolCall: { callId: "call-flag" } } },
  { type: "tool/call", data: { turn: 5, callId: "call-flag-kill", name: "KillShell", arguments: JSON.stringify({ job_id: "bash-flag" }) } },
  { type: "tool/result", data: { turn: 5, isError: true, message: { role: "tool", toolCallId: "call-flag-kill", content: "still running" } } },
]);
assert.equal(flaggedKill[0].open, true);
for (const failure of [
  { message: { role: "tool", toolCallId: "call-x", isError: true, content: "ok\n[exit code: 0]" } },
  { isError: true, message: { role: "tool", toolCallId: "call-x", content: "ok\n[exit code: 0]" } },
  { error: { reason: "refused" }, message: { role: "tool", toolCallId: "call-x", content: "ok\n[exit code: 0]" } },
  { message: { role: "tool", toolCallId: "call-x", content: "nope\n[exit code: 1]" } },
]) {
  const open = collectJobs([
    { type: "job/registered", data: { turn: 1, jobId: "bash-x", label: "serve", toolCall: { callId: "call-start" } } },
    { type: "tool/call", data: { turn: 2, callId: "call-x", name: "job_kill", arguments: JSON.stringify({ job_id: "bash-x" }) } },
    { type: "tool/result", data: { turn: 2, ...failure } },
  ]);
  assert.equal(open[0].open, true);
}
const settledAfterFail = collectJobs([
  { type: "job/registered", data: { turn: 1, jobId: "bash-y", label: "serve", toolCall: { callId: "call-start" } } },
  { type: "tool/call", data: { turn: 2, callId: "call-y", name: "job_kill", arguments: JSON.stringify({ job_id: "bash-y" }) } },
  { type: "tool/result", data: { turn: 2, isError: true, message: { role: "tool", toolCallId: "call-y", content: "still running" } } },
  { type: "job/settled", data: { turn: 3, jobId: "bash-y", status: "killed", toolCall: { callId: "call-y" } } },
]);
assert.equal(settledAfterFail[0].open, false);
assert.equal(settledAfterFail[0].status, "killed");

const stillOpen = collectJobs([
  { type: "tool/call", data: { turn: 2, callId: "call-open", name: "bash", arguments: JSON.stringify({ command: "python3 serve.py" }) } },
  { type: "job/registered", data: { turn: 2, jobId: "bash-open", label: "python3 serve.py", kind: "bash", toolCall: { callId: "call-open" } } },
  { type: "tool/result", data: { turn: 2, message: { role: "tool", toolCallId: "call-open", content: "started background job bash-open" } } },
]);
assert.equal(stillOpen[0].open, true);
const openCard = buildCard("Must keep ledger.txt", "", [
  { role: "user", text: "Must keep ledger.txt", turn: 9 },
], { jobs: stillOpen });
assert.equal(openCard.ok, true);
assert.equal(openCard.text.includes("bash-open"), true);
assert.equal(openCard.text.includes("still open at cut time, so later files follow disk state"), true);
assert.equal(openCard.text.includes("[call-open]"), true);
assert.equal(jobCutDecision(stillOpen).cut, true);
assert.equal(jobCutDecision([{ jobId: "forever", open: true, startTurn: 1 }]).cut, true);

const settled = collectJobs([
  { type: "job/registered", data: { turn: 3, jobId: "sub-1", label: "review", kind: "subagent", toolCall: { callId: "call-sub" } } },
  { type: "job/settled", data: { turn: 7, jobId: "sub-1", label: "review", kind: "subagent", status: "completed", toolCall: { callId: "call-sub" } } },
]);
assert.equal(settled[0].open, false);
assert.equal(jobCardLines(settled, { startTurn: 3, endTurn: 4 }).some((line) => line.includes("still open")), false);
assert.equal(jobCardLines(settled, { startTurn: 3, endTurn: 4 }).some((line) => line.includes("ended in turn 7")), true);
assert.equal(jobCardLines(settled, { startTurn: 8, endTurn: 9 }).length, 0);

const root = join(tmpdir(), `spine-three-${Date.now()}`);
mkdirSync(root, { recursive: true });
const original = `HEAD${"M".repeat(200000)}TAIL`;
const saved = captureToolResult({
  dir: root,
  toolCallId: "call-raw",
  text: original,
  turn: 4,
  name: "read",
  pathLabel: readResultLabel("read", "ledger.txt", 4),
});
assert.equal(readFileSync(saved.path, "utf8"), original);
assert.equal(saved.path.endsWith(rawName("call-raw")), true);
assert.equal(saved.sha256, contentHash(original));
assert.equal(original.includes("[... tool result middle pruned ...]"), false);
const prunedText = `${original.slice(0, 100)}\n\n[... tool result middle pruned ...]\n\n${original.slice(-50)}`;
const again = captureToolResult({ dir: root, toolCallId: "call-raw", text: prunedText, turn: 4, name: "read" });
assert.equal(again.existed, true);
assert.equal(readFileSync(again.path, "utf8"), original);
const missed = captureToolResult({ dir: root, toolCallId: "call-pruned", text: prunedText, turn: 4, name: "bash" });
assert.equal(missed.ok, false);
assert.equal(existsSync(join(root, rawName("call-pruned"))), false);
writeFileSync(join(root, "not-dir"), "x");
const blocked = captureToolResult({ dir: join(root, "not-dir", "raw"), toolCallId: "call-blocked", text: "hello" });
assert.equal(blocked.ok, false);
assert.equal(pointerFor(blocked), "No complete backup [call-blocked]");
assert.equal(pointerFor(blocked).includes(root), false);
const pointer = pointerFor(saved);
assert.equal(pointer.includes("Read in turn 4, ledger.txt"), true);
assert.equal(pointer.includes(`sha256:${saved.sha256.slice(0, 12)}`), true);
assert.equal(pointer.includes(`${saved.bytes} bytes`), true);
assert.equal(pointer.includes("[call-raw]"), true);
assert.equal(pointer.includes("current content"), false);
assert.equal(readResultLabel("bash", "ledger.txt", 4), "");
const rawCard = buildCard("", "", [{
  role: "tool",
  text: original,
  command: "read",
  name: "read",
  toolCallId: "call-raw",
  turn: 4,
  raw: saved,
}]);
assert.equal(rawCard.text.includes(pointer), true);
assert.equal(rawCard.text.includes("[... tool result middle pruned ...]"), false);
const trust = join(root, "trust");
mkdirSync(trust);
const trusted = captureToolResult({ dir: trust, toolCallId: "id-trust", text: "ORIGINAL", turn: 1, name: "bash" });
writeFileSync(trusted.path, "TAMPERED");
const reread = captureToolResult({ dir: trust, toolCallId: "id-trust", text: "ORIGINAL", turn: 1, name: "bash" });
assert.equal(reread.ok, false);
assert.equal(pointerFor(trusted), "No complete backup [id-trust]");
assert.equal(verifiedRaw(trusted).ok, false);
assert.equal(rawExcerptText("surface original", trusted).text, "surface original");
assert.equal(rawExcerptText("head\n\n[... tool result middle pruned ...]\n\ntail", trusted).text, "");
const userMarker = "Preserve [... tool result middle pruned ...] this explanation";
assert.equal(rawExcerptText(userMarker, null).text, userMarker);
const userCard = buildCard(userMarker, "", [{ role: "user", text: userMarker }]);
assert.equal(userCard.text.includes(userMarker), true);
assert.equal(userCard.ok, true);
const onlyMarker = "[... tool result middle pruned ...]";
assert.equal(rawExcerptText(onlyMarker, null).text, onlyMarker);
const markedUser = "Must preserve [... tool result middle pruned ...]";
assert.equal(buildCard(markedUser, "", [{ role: "user", text: markedUser }]).text.includes(markedUser), true);
assert.equal(verifiedIds([{ toolCallId: "bad", ok: false }]).size, 0);
assert.throws(() => runPruneAfterCapture(["bad"], verifiedIds([{ toolCallId: "bad", ok: false }]), () => {}), /raw backup missing/);
let partialWrites = 0;
assert.throws(() => runPruneAfterCapture(["good", "bad"], new Set(["good"]), () => {
  partialWrites += 1;
}), /raw backup missing/);
assert.equal(partialWrites, 0);
let fullWrites = 0;
runPruneAfterCapture(["good"], new Set(["good"]), () => {
  fullWrites += 1;
});
assert.equal(fullWrites, 1);
rmSync(`${trusted.path}.meta.json`);
const missingMeta = captureToolResult({ dir: trust, toolCallId: "id-trust", text: "ORIGINAL", turn: 1, name: "bash" });
assert.equal(missingMeta.ok, false);
const restored = restoreToolText(
  { role: "tool", toolCallId: "call-raw", content: "head\n\n[... tool result middle pruned ...]\n\ntail" },
  saved,
);
assert.equal(restored.content, original);
assert.equal(restoreToolText({ role: "tool", content: "pruned [... tool result middle pruned ...]" }, saved).content.includes("pruned"), true);
const prunedMessages = [{ role: "tool", toolCallId: "missing", content: "x\n[... tool result middle pruned ...]\n" }];
assert.equal(backupClaimOk(prunedMessages), false);
assert.equal(backupClaimOk([restored]), true);
const claimed = `Card\nThe omitted raw tool text is at /tmp/cut.txt. Read only the directory that holds this file; do not scan other sessions. Read it only when you need that raw text; do not pull it in by default.`;
assert.equal(withoutFullBackupClaim(claimed, "/tmp/cut.txt").includes("The omitted raw tool text is at"), false);
assert.equal(withoutFullBackupClaim(claimed, "/tmp/cut.txt").includes("no complete backup"), true);

let pruned = false;
assert.throws(() => runPruneAfterCapture(["call-raw"], new Set(), () => {
  pruned = true;
}), /raw backup missing before prune/);
assert.equal(pruned, false);
runPruneAfterCapture(["call-raw"], new Set(["call-raw"]), () => {
  pruned = true;
});
assert.equal(pruned, true);

const rounds = [{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }];
assert.deepEqual(chooseKeptSpan(rounds, () => 1000, 32000), { start: 0, end: 5 });

assert.equal(isPluginShadowName("raw-0123456789abcdef.txt"), true);
assert.equal(isPluginShadowName("raw-0123456789abcdef.txt.meta.json"), false);
const dead = join(root, "session-dead");
mkdirSync(dead, { recursive: true });
writeFileSync(join(dead, "raw-0123456789abcdef.txt"), "x".repeat(80));
writeFileSync(join(dead, "raw-0123456789abcdef.txt.meta.json"), "{}");
const rotated = rotateShadow({
  dir: root,
  incomingBytes: 10,
  protectPath: join(root, "session-mine", "cut-1-aaaaaaaa.txt"),
  sessionKey: "session-mine",
  cap: 20,
});
assert.equal(rotated.ok, true);
assert.equal(existsSync(join(dead, "raw-0123456789abcdef.txt")), false);
assert.equal(existsSync(join(dead, "raw-0123456789abcdef.txt.meta.json")), false);
const keptRaw = join(dead, "raw-aaaaaaaaaaaaaaaa.txt");
writeFileSync(keptRaw, "keep-this-raw");
writeFileSync(join(dead, "raw-bbbbbbbbbbbbbbbb.txt"), "drop-this-raw");
rotateShadow({
  dir: root,
  incomingBytes: 10,
  protectPath: join(root, "session-mine", "cut-2-bbbbbbbb.txt"),
  protectPaths: [keptRaw],
  sessionKey: "session-mine",
  cap: 20,
});
assert.equal(existsSync(keptRaw), true);
assert.equal(existsSync(join(dead, "raw-bbbbbbbbbbbbbbbb.txt")), false);

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
assert.equal(index.includes("if (!decision.cut) return null"), true);
assert.equal(index.includes("runPruneAfterCapture"), true);
const guarded = index.slice(index.indexOf("function guarded"));
assert.equal(guarded.includes("engine.captureSession(session)"), true);
assert.equal(guarded.indexOf("engine.captureSession(session)") < guarded.indexOf("runPruneAfterCapture"), true);
assert.equal(index.includes("toolCallId: event?.data?.message?.toolCallId"), true);
assert.equal(index.includes("rawExcerptText"), true);
assert.equal(index.includes("withoutFullBackupClaim"), true);
rmSync(root, { recursive: true, force: true });
console.log("three-fix checks passed");
