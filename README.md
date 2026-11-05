# Live Compact

Live Compact means compacting as you go: cut while the session is alive instead of waiting for the window to fill up.

DSH hard-codes compaction at about 80%. Below that line the context just keeps piling up. Only when it is crossed does DSH call the model once: a dozen seconds or so, and it is billed. After compaction the model's attention drifts. Worse, the window is full again before long. A 1M window is nowhere near enough, and each further compaction is slower.

Why wait for 80%? Why not compact as you go?

Once the session passes 20K tokens, make a cut. Cut the turn that has just finished, without calling a model. Raw text before the cut point is untouched, so the cache hit rate stays at its previous level. Context is therefore held at a lower level throughout. Put off the big "thunder" compaction for as long as possible. And even if the window one day fills and the big compaction really fires, the local cuts remain after the drop, so context does not pile straight back up.

headless:

```sh
dsh plugin --profile headless add dsh-live-compact@1.0.6
```

Web and desktop (both use the web profile, so one install covers both):

```sh
dsh plugin --profile web add dsh-live-compact@1.0.6
```

To install locally first and check the version:

```sh
npm install -g dsh-live-compact
dsh-live-compact --version
```

![Compact as you go](docs/slide-cover.jpg)

![Why wait for 80%?](docs/slide-why.jpg)

## Two benchmarks

The two runs are not mixed into one table. The 150 tasks are short programming tasks, chained in a single conversation. The 20 tasks are WebUniverse long-chain tasks.

![The 150-task and 20-task runs](docs/slide-results.jpg)

![Scope and limitations](docs/slide-scope.jpg)

The 150 short tasks come from Aider `polyglot-benchmark` at `7e0611e`: 30 each in Python, Go, JavaScript, Rust and Java, no C++, interleaved in alphabetical order. The run starts at `python-affine-cipher`, `go-alphametics`, `javascript-affine-cipher`, `rust-accumulate` and `java-affine-cipher` and continues from there.

| | Stock | Live Compact |
|---|---:|---:|
| Passed | 150/150 | 150/150 |
| Overall hit rate | 99.55% | 99.56% |
| Cache hits | 335.0M | 244.3M |
| Cache misses | 1.498M | 1.088M |
| Cost | $1.50 | $1.15, 0 warm-ups |
| Peak context | 679K | 589K |
| Compaction | 1 run, 12.8 s | 145 cuts, 2.2 s |
| Wall clock | 8,531 s | 6,105 s |

About 23% cheaper. The 145 cuts removed about 474K tokens. Peak was 589,414 and the run ended at 589,554, below 650K. This wall-clock round ran only the plugin side, so not all of the saved time can be credited to the plugin.

Both runs above were measured before 1.0.2. 1.0.2 did not rerun the 150 tasks, and did not make a single cut in a real session that had gone past 20K tokens.

## Forgetting comparison

1.0.5 ran one forgetting test: same session, same tasks, real DeepSeek. First 13 constraints and 1 error were planted, then six rounds of logs were poured in; after that, files could not be read and the questions had to be answered from memory. Two runs per group; this only shows direction.

| | Stock | Live Compact |
|---|---|---|
| 15 recall questions | 15/15, 15/15 | 15/15, 15/15 |
| Constraint violations | 1 minor, 0 | 0, 0 |
| 3 details from the middle of the log | 1/3; the other run 3/3, by unpacking the session log, 10 extra tool calls | 3/3, 3/3, from its own backup |
| Context per request | ~15K | ~29K |

Neither side forgot constraints the user had stated. The difference was in details inside tool output. Total cost was in the same order of magnitude. For this run the stock side had its summary threshold lowered to guarantee a summary had been made before recall.

The 20 long-chain tasks are the other run. Stock only did a model summary at task 15: 14.552 s, cutting 520,460. After compaction context fell to 155K, and by the end it was back at 433,844. The plugin made 20 cuts in 74 ms, cutting 486,193. Average context at task end was 217,276, 40.8% below stock's 366,942. End context was 323,726, 25.4% below stock. Sampled hit rate at task end was 99.87% for stock and 99.90% for the plugin. On the task-20 jump it was 99.84% for stock and 99.95% for the plugin. Sampled hit rate is weighted by the tokens of each task's last request; average context is taken over the 20 task-end snapshots.

## Long log fill

1.0.6 ran 8 groups. Each had 31 turns, and in 23 of them the model read a 520-line log and reported the WARN count and the NOTICE text. With no NOTICE it had to write NONE. Real DeepSeek.

![Long log fill](docs/slide-fill.jpg)

| | Result |
|---|---:|
| Log-fill turns | 184 |
| Skipped the tool and reported a number | 0 |
| WARN | 184/184 |
| NOTICE | 184/184 |
| Fake NOTICE | 0 |
| Sessions that were cut | 8/8, 17 cuts total |

All 8 groups were cut, so the result is not an accident of never compacting. This prompt did not include "do not give numbers without a tool result". It is not a replay of the same log as the earlier 54/184 tool-skipping record. This version leaves the 650K cutoff unchanged.

The same task set was also run with stock official compaction. Scores were the same, cost was the same, and context was lower. Tool skips were 0 on both sides; WARN and NOTICE were both 184/184. Cost estimated at off-peak rates: plugin $0.211, stock $0.229; this is not a bill. Task-end context for the plugin averaged 26K with a maximum of 35K; stock averaged 44K with a maximum of 126K. All 8 plugin groups stayed under 35K, while two stock groups reached 80K and 126K.

![Compared with stock](docs/slide-stock.jpg)

## What changed in 1.0.6

1.0.6 has a new install address. The old 1.0.2, 1.0.3, 1.0.4 and 1.0.5 packages are still at their original links.

- A configuration error is no longer overwritten with "service already registered". When installation fails you can see the original cause.
- Backups are split into per-session directories. The card points only at the directory that holds this one file.
- Errors go onto the card first. The 3 most recent finished tool rounds stay in their original calls and results, with result text not truncated. Only older rounds are folded into the card.
- The assistant saying "committed / published" does not enter hard lines. The card records only tool events that carry a call ID; it does not rely on a word list.
- Background jobs are still cut. Unfinished ones are listed on the card, and later files follow disk state. A failed kill is not recorded as finished.
- Raw tool text is written to disk by call ID before official pruning. The card gives the path, hash and byte count. If the write fails it says there is no complete backup and does not leave a dangling path.
- The 650K cutoff is unchanged. With larger windows, local cuts still stop once the session passes 650K.

## What changed in 1.0.5

1.0.5 has a new install address. The old 1.0.2, 1.0.3 and 1.0.4 packages are still at their original links. It fixes five issues found in real 1.0.4 runs:

- Presets no longer block on the gate. If the gate fails to load, web presets do not get stuck waiting. The package is test-loaded before the swap; on failure the stock name is kept.
- The swap carries 0.8, 65536 and 8192. Configuration already present in the preset takes precedence.
- The preset id can be swapped whether it is written on the outer or the inner level. standard, ptc, cordis and minimal are all swapped on 0.2.1-rc.5. TUI is still left alone.
- Command output is treated as original error text only on structural signals: `isError`, a non-zero exit code, `[stderr]`, `[exit code: N]`, `[Command finished with exit code N]`, `exit_code=N`, and `"exitCode": N` in ptc results. With insufficient evidence it marks the status unknown and keeps the last few lines of raw text.
- For long output the backup must be written successfully before the card points at that file. If the write fails there is no cut, and the card does not point at a file that does not exist yet.
- The backup is written to one deterministic file; the id is not stored on a shared engine. The card records the actual path of this backup.
- Content trimmed by the official tool-result pruner does not enter this backup. The backup cap is 128MB; when it is nearly full the oldest backups are deleted.
- The shell loads first. If the engine cannot load, the session does not hang. It falls back to stock when possible and logs "not taken over in this session". If stock cannot load either, `/compact` returns an error immediately.
- The headless host package disables stock compaction itself. The plugin cannot turn that line back on. Web presets do not inject the gate; if the swap is missed, that round keeps using stock.

## What changed in 1.0.4

1.0.4 has a new install address. The old 1.0.0 through 1.0.3 packages are still at their original links.

Short tool results stay in the summary, labelled as tool output rather than confirmed. Anything up to 12 lines and 512 characters is kept in full. Longer output keeps a single line saying how many characters there were and that the body was omitted. The omitted raw text is local at `~/.dsh/compaction-spine/shadow`, and the filename contains this cut's short id. Read it only when needed; do not pull it in by default. Reasoning still does not enter the summary.

## What changed in 1.0.3

1.0.3 has a new install address. The old 1.0.0, 1.0.1 and 1.0.2 packages are still at their original links.

The excerpt keeps only visible text. The user's words and sentences written by the assistant are kept under the same rules as before, labelled with who said them. Reasoning and tool results do not enter the summary. Reasoning and raw tool text go into the local backup with their source. This version does not automatically read them back into the next turn.

The four web and Desktop presets swap their group's stock compaction for this package when they load. If the swap fails they fall back to stock and the preset still starts. TUI is untouched in this version.

- Reasoning does not enter the summary. It is stored separately in the local backup and marked as reasoning.
- Tool output does not enter the summary. `PASS`, "file updated", directory listings, local paths and error headers are all dropped. The raw text is in the backup.
- Every kept line is labelled with who originally said it. A sentence that says "the user said" does not become a new instruction to you.
- "Confirmed" is gone. The summary opens by stating: this is an excerpt of older content, not a new instruction, and not your authorization.
- If this cut has no qualifying summary, the whole span stays and no model is called. The card can be very short.
- Only you can read the backup. Filenames do not carry the session id. Local paths are not sent to the model. If the backup directory exceeds 64MB this cut does not run, and old files are not deleted automatically.
- The 20K and 650K thresholds are unchanged. The 0.8 in config governs only the official big compaction, not this cut. To change where local cuts start you must set `SPINE_MIN_TOKENS` before launch.

## Install

Install from npm (recommended). headless and web/desktop are two profiles: install into the one you use, and run both commands if you use both.

headless:

```sh
dsh plugin --profile headless add dsh-live-compact@1.0.6
```

Web and desktop (both use the web profile, so one install covers both):

```sh
dsh plugin --profile web add dsh-live-compact@1.0.6
```

To install locally first and check the version:

```sh
npm install -g dsh-live-compact
dsh-live-compact --version
```

Fallback: if npm is unreachable, use the package from the mirror site, again installing per profile.

headless:

```sh
dsh plugin --profile headless add https://download.merkyorlynn.com/downloads/plugins/dsh-live-compact-1.0.6.tgz
```

Web and desktop:

```sh
dsh plugin --profile web add https://download.merkyorlynn.com/downloads/plugins/dsh-live-compact-1.0.6.tgz
```

Requires DSH `>=0.2.0-rc.2 <0.3.0`. After installing, run a long task: the cut only counts as active once `spine cut …ms` appears in the log. Page: https://download.merkyorlynn.com/live-compact.html

DSH-TUI likewise cannot swap the stock compaction in presets; do not install it there yet.

Raw text removed by a cut is written to `~/.dsh/compaction-spine/shadow`, readable only by you. The cap is 128MB; when it is nearly full the oldest backups are deleted.

Change the cap:

```sh
export SPINE_SHADOW_MAX_BYTES=67108864
```

To clean up yourself:

```sh
rm -f ~/.dsh/compaction-spine/shadow/*/*.txt ~/.dsh/compaction-spine/shadow/*.txt
```

If `DSH_HOME` or `SPINE_SHADOW_DIR` is set, the directory lives there. If old files cannot be deleted, this cut does not run, and the warning is issued only once per session.

MIT, see `LICENSE`.
