# Rex Terminal Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task below is filed as one GitHub issue on `Jessehuze/rex-hive`; the issue body is the task plus the Global Constraints.

**Goal:** Add Rex as an opt-in second terminal for hive, so leads, workers and processes run as native Rex blocks. tmux stays the default and is unchanged.

**Architecture:**
- A facade, `src/terminal.ts`, re-exports the pane functions call sites already use from `src/tmux.ts`, with the same names and signatures.
- Each function dispatches on the target: `block:` → Rex (`src/terminal/rex.ts` over `src/rexCli.ts`); anything else falls through to the unchanged tmux function.
- Rex locators live in the existing `tmux_*` columns. There are no migrations.
- A seam guard test keeps upstream merges from silently bypassing the facade.

**Tech Stack:** TypeScript (ESM, `tsc`), Node `^22.14 || >=23.6`, better-sqlite3, `node:test` (`test/*.test.mjs` against `dist/`), the `rex` CLI (`0.1.0-preview.25`, api_revision 24).

**Spec:** `docs/superpowers/specs/2026-11-25-rex-terminal-backend-design.md`. Every executor reads it; section numbers (§) below refer to it.

## Global Constraints

These apply to every task.

**Process**
- Build before testing: `npm run build`, then run a single file with `node scripts/run-tests.mjs test/<file>.test.mjs`. Run the full suite with `npm test`. Read `test/CLAUDE.md` before writing any test.

**Upstream tests and the existing suite**
- No upstream test file is edited. The existing suite must stay green with the tmux backend after every task.
- No entry is added to `MIGRATIONS` in `src/db.ts`.

**Behaviour without Rex**
- With no `HIVE_TERMINAL=rex` and no `terminal: rex` in any config, hive makes zero `rex` invocations. That holds even when `REX_BLOCK` and `REX_SERVER` are set.
- New behaviour ships off: everything here applies only when Rex was chosen, or to rows already recorded as Rex.

**Calling `rex`**
- Every `rex` invocation goes through `src/rexCli.ts`, as `execFileSync`/`spawnSync` argument arrays.
- Every invocation carries `--autostart=false` and `--timeout 10s`.
- hive never starts a Rex server.

**Rex locators in the store**
- Rex target: `block:<uuid>`. Rex socket: `rex:<server url>`.
- Rex rows are recognised only by those prefixes.

**Code and docs**
- Comment ratio stays under 5% per group (`test/comment-ratio.test.mjs`). A test's name states what it pins.
- No personal names, home paths, session ids or other projects in tracked files or fixtures (CLAUDE.md "shipped tree" invariant).
- New `docs/*.md` pages cite `file:line` correctly (`test/docs.test.mjs`).
- Before changing anything under `src/tmux.ts`, `src/spawn.ts`, `src/scheduler.ts`, `src/hook.ts`, `src/tools/agents.ts` or `src/cli.ts`, invoke the `hive-internals` skill for the matching rule.

**Tests and Rex**
- Tests never contact a real Rex server. Every Rex test uses the fake `rex` from Task 4, and every file that spawns hive also calls `isolateTmux()` at top level.

**Branches and commits**
- One branch and one PR per task, based on `main`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

These are the failure modes most likely to hurt a user. Each has its test in the owning task.

1. **Rex app/server quits mid-day:** rows read `unknown`, wakes hold rather than cancel, and nothing is reaped until the 10-minute grace passes. After that they are reaped as `gone`. Task 5: `rex-ownership.test.mjs` "unreachable server holds for the grace window then reads gone".
2. **User closes a worker's block by hand in Rex:** the row reads `gone`, a pending wake to it is cancelled, and the dead-process notice fires once. Task 5: "closed block reads gone and cancels its wake".
3. **User drags a worker's tab into another Rex session:** delivery and capture still work, because the session is resolved per call. Task 5: "block moved to another session is still live and receives text".
4. **A long message with shell metacharacters and newlines:** `$`, `&`, quotes, backticks and a 20,000-char body arrive byte-identical. A message with an unsafe control char is refused before any `rex` call. Task 5: "paste carries metacharacters and 20k chars intact".
5. **tmux user running hive inside a Rex terminal:** with `REX_BLOCK`/`REX_SERVER` set but terminal resolved to tmux, panes are tmux panes and the fake `rex` log is empty. Task 3: "tmux terminal inside Rex makes no rex calls".

---

### Task 1: Facade module with tmux-only dispatch

**Files:**
- Create: `src/terminal.ts`
- Modify: every `src/**/*.ts` that imports a terminal-touching function from `./tmux.js`/`../tmux.js` (31 files; list with `grep -rl 'tmux\.js"' src`). Change the import path only.
- Test: `test/rex-seam-guard.test.mjs`

**Interfaces:**
- Produces, in `src/terminal.ts`:
  - re-exports with identical signatures for `sendText`, `capturePane`, `captureRawPane`, `targetLive`, `targetLiveProbe`, `rowLive`, `rowAlive`, `rowLiveProbe`, `rowAliveProbe`, `rowOwnership`, `observeRowOwnership`, `liveTargets`, `targetAlive`, `targetPid`, `panePid`, `panePidForRecord`, `paneProcessExited`, `paneInCopyMode`, `cancelCopyMode`, `paneCurrentCommand`, `paneTitle`, `inputBoxSnapshot`, `inputBoxState`, `claudeTrailerView`, `paneChoiceCheck`, `paneAwaitingChoice`, `codexInputBoxState`, `codexTrailerView`, `codexPaneChoiceCheck`, `pollPaneReadiness`, `waitForPaneInput`, `waitForPaneEstablished`, `setRemainOnExit`, `captureFinalScreen`, `foreignSocket`;
  - `isRexTarget(target: string): boolean` (`target.startsWith("block:")`);
  - `isRexSocket(socket: string): boolean` (`startsWith("rex:")`);
  - `rexServerOf(socket: string): string` (strips `rex:`).
- In this task every function forwards to `./tmux.js`. Task 5 adds the Rex branches.
- Pure helpers (parsers, `shellQuote`, `stripControlBytes`, `sanitizeTail`, `findUnsafeControlChar`, constants, types) stay imported from `./tmux.js`.

- [ ] **Step 1: Baseline.** Run `npm install && npm run build && npm test`. Record pass/fail counts, plus the list of test files that call `isolateTmux()` (`grep -l isolateTmux test/*.test.mjs | wc -l`), in the PR description. Expected: suite green on `main`. If not, stop and report.
- [ ] **Step 2: Write the failing seam guard test** `test/rex-seam-guard.test.mjs`:
  - `it("no src file imports a terminal-touching tmux.js export outside the facade")`: parse every `src/**/*.ts` import from `tmux.js`. Assert that each imported name is in `PURE_TMUX_EXPORTS` (a list in the test), or that the importing file is `src/terminal.ts` or `src/terminal/*.ts`.
  - `it("only tmux.ts, terminal files and rexCli.ts execute tmux or rex")`: regex-scan `src/` for `("tmux"`, `tmux(` calls and `("rex"`. Allowlist: `src/tmux.ts`, `src/terminal.ts`, `src/terminal/**`, `src/rexCli.ts`, and the direct-call sites Task 2 moves, as a `PENDING_TASK_2` list that Task 2 empties.
  - `it("guard catches a planted violation")`: run the scanner over an in-memory string `import { sendText } from "./tmux.js"` in `src/x.ts`. Assert one violation.
- [ ] **Step 3: Run it.** `npm run build && node scripts/run-tests.mjs test/rex-seam-guard.test.mjs`. Expected: the first test FAILS, listing the 31 importing files.
- [ ] **Step 4: Create `src/terminal.ts`** with forwarders and the prefix helpers. Switch the imports in the 31 files.
- [ ] **Step 5: Verify.** Run `npm run build && npm test`. Expected: the full suite is green, including `test/sender-tag-sites.test.mjs` and `test/import-graph.test.mjs` (no cycles), and the seam guard passes.
- [ ] **Step 6: Commit** with the message `Facade for pane functions; seam guard`.

### Task 2: Move direct tmux calls and tmux env reads behind the facade

**Files:**
- Modify:
  - `src/cli.ts`: lines ~558-572 (attach `spawnSync("tmux")`), ~923 (`split-window`), ~967 (`kill-pane`), 677, 1001, 3115, and `TMUX*` reads;
  - `src/spawn.ts`: 193-199 (kill), 280 (`split-window`), 341, 479;
  - `src/tools/agents.ts`: 6 direct calls;
  - `src/processes.ts`: 3 calls;
  - `src/leadHandoffCli.ts`: 93, 304, 342;
  - `src/leadHandoff.ts`: 678;
  - `src/hook.ts`: 253;
  - `src/context.ts`: 48;
  - `src/wakeTarget.ts`: 67;
  - `src/scheduler.ts`: 381.
- Modify: `src/terminal.ts`
- Test: `test/rex-seam-guard.test.mjs` (empty `PENDING_TASK_2`, and add the env test)

**Interfaces:**
- Produces, in `src/terminal.ts`:
  - `callerPane(): string`: `TMUX_PANE` today; Task 5 adds `REX_BLOCK`.
  - `callerSocket(): string`: `tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR)` today; Task 5 adds `rex:` + server.
  - `insideTerminal(): boolean`: `!!process.env.TMUX` today.
  - `killPane(target: string): void`
  - `splitPane(args: SplitArgs): { target: string; pid: string }`, wrapping the exact existing `split-window` argv
  - `respawnPane(args: RespawnArgs): { target: string }`, wrapping `respawn-pane -k`. The returned target equals the input on tmux.
  - `attachInteractive(argv: string[]): number`
- Each wrapper takes the values the call site already computes. Its tmux body is the moved code, verbatim.

- [ ] **Step 1: Write the failing test** `it("TMUX, TMUX_PANE, TMUX_TMPDIR, REX_BLOCK, REX_SERVER are read only in the facade, tmux.ts and rexCli.ts")`. Scan for `process.env.TMUX` (all three), `process.env.REX_`. The allowlist is those three files. Empty `PENDING_TASK_2`.
- [ ] **Step 2: Run it.** Expected: FAIL, listing the files above.
- [ ] **Step 3: Implement the wrappers.** Replace each call site with a one-line facade call. In `leadHandoffCli.ts:304`, assign the returned target back to the value the handoff records. This is a no-op on tmux; Task 7 relies on it.
- [ ] **Step 4: Verify.** Run `npm run build && npm test`. Expected: full suite green, including `test/pane-created-with-its-command.test.mjs`. If that test pins call sites by file and fails, keep a literal `split-window`/`new-window` argv at the original site and pass it into the wrapper as an argument (do not edit the test).
- [ ] **Step 5: Commit** with the message `Direct tmux calls and env reads go through the facade`.

### Task 3: Terminal setting, store encoding, and Rex refusal stub

**Files:**
- Modify:
  - `src/projectYml.ts`: `terminal`, `workers`, and the per-process `wait_for_port` key. Parse and validate the way `placement` is validated.
  - `src/globalConfig.ts`: the `terminal` key, and `writeGlobalConfigKey` accepting `"terminal"`.
  - `src/cli.ts`: `hive setup --terminal rex|tmux`. `cmdLead`, `hive queen` and `hive next` resolve the terminal and branch.
  - `src/terminal.ts`
- Create: `src/terminal/rex.ts`. Stub: every operation throws `RexNotImplemented`.
- Test: `test/rex-terminal-setting.test.mjs`

**Interfaces:**
- Produces, in `src/terminal.ts`:
  - `type Terminal = "tmux" | "rex"`
  - `resolveTerminal(project: { terminal: Terminal | null }): { terminal: Terminal; source: "env" | "project" | "global" | "default" }`. Order: `HIVE_TERMINAL`, then project `hive.yml`, then global config, then `"tmux"` (§5.1).
  - `terminalOfRow(row: { tmux_target: string; tmux_socket: string }): Terminal`, from the prefixes.
  - `rexInUse(): boolean`. True iff the kv key `terminal:rex:in-use` exists in the store, or `resolveTerminal` gives `rex` for the current cwd's project. Facade functions consult this before any Rex snapshot.
- In `src/projectYml.ts`:
  - config fields `terminal: Terminal | null` and `workers: "shown" | "hidden" | null`;
  - process field `wait_for_port: number | true | null`.
- Workers, processes and handoff successors take `terminalOfRow(leadRow)`, never `resolveTerminal`.

- [ ] **Step 1: Write the failing tests:**
  - `it("HIVE_TERMINAL beats hive.yml beats global config beats tmux")`: 4 cases. Assert `{terminal, source}` for each.
  - `it("unknown terminal value warns and resolves tmux")`: `terminal: screen` gives a warning containing `terminal must be "tmux" or "rex"`, and `source: "default"`.
  - `it("hive setup --terminal rex writes the global key")`: read back the config file.
  - `it("hive lead with terminal rex refuses with the way back")`: exit 1, and stderr contains `HIVE_TERMINAL=tmux`.
  - `it("tmux terminal inside Rex makes no rex calls")`: set `REX_BLOCK=block:fake`, `REX_SERVER=unix:///nonexistent`, and PATH with a recording `rex` stub that appends to a log. Run `hive lead --detach` on tmux plus one `hive status`. Assert the log file is empty, and assert the lead row's target matches `/^%\d+$/`.
  - `it("a worker spawned under a tmux lead stays tmux after hive.yml switches to rex")`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the resolution, the config keys and the setup flag. Rex branches call the `src/terminal/rex.ts` stub, which throws `RexNotImplemented`. The CLI prints it as `hive lead: the Rex terminal is not available in this build; set HIVE_TERMINAL=tmux`.
- [ ] **Step 4: Verify.** Run `npm run build && npm test`. Expected: green.
- [ ] **Step 5: Commit** with the message `Terminal setting and Rex row encoding`.

### Task 4: rex CLI wrapper, fake rex, and real-screen fixtures

**Files:**
- Create: `src/rexCli.ts`
- Create: `test/fixtures/fake-rex/rex` (executable Node script), `test/rex-helpers.mjs`
- Create: `test/fixtures/rex/README.md`, plus captured fixtures `test/fixtures/rex/{claude-idle,claude-typing,claude-dialog,codex-idle}.vt`
- Test: `test/rex-cli.test.mjs`

**Interfaces:**
- Produces, in `src/rexCli.ts`:
  - `class RexError extends Error { code: string; stderr: string }`, `class RexTimeoutError extends RexError`, `class RexUnavailableError extends RexError` (not installed, or server unreachable)
  - `const REX_TIMEOUT = "10s"`
  - `rexApi<T>(server: string, method: string, params: object): T`. Runs `rex --autostart=false --timeout 10s -S <server> api call <method> <json>` and parses stdout as JSON.
  - `rexKey(server: string, block: string, key: string): void`
  - `rexLua<T>(server: string, script: string): T`. Runs `rex … -S <server> do -e <script>` and parses the result as JSON. Confirm the output flag with `rex do --help`.
  - `defaultRexServer(): string | null`. Returns `REX_SERVER` if set, otherwise `rex whoami --json`'s server address, cached per process.
  - `SNAPSHOT_SCRIPT: string`. The Lua script for Task 5. Its first line is `-- hive:snapshot v1`.
- Produces, in `test/rex-helpers.mjs`:
  - `isolateRex(tmp): { env, state(): FakeState, calls(): Call[] }`. Puts the fake first on PATH. Sets `REX_SERVER=unix://<tmp>/fake-rex.sock` and `FAKE_REX_STATE=<tmp>/fake-rex.json`. Deletes `REX_BLOCK` and `REX_SESSION`.
  - `fakeRexDo(tmp, op)`, which simulates user actions: `closeBlock`, `transferWindow`, `stopServer`, `restartServer`.
- The fake implements the `api call` methods used by Tasks 5-14:
  - `session.list`, `session.create`, `session.view`, `session.list_blocks`, `session.new_window`, `session.new_split`, `session.new_block`, `session.move_block`, `session.float_block`, `session.set_layer_state`, `session.detach_block`, `session.set_block_label`, `session.set_window_label`, `session.focus_block`, `session.resize_pane`
  - `target.resolve`, `block.event` (paste, key), `block.close`, `block.method`: `com.superlogical.terminal.{process,format,title,modes,program_status,ports,resize}`
  - `client.perform`
- It also implements `send-key`, `wait`, `whoami --json`, and `do -e` for the `-- hive:snapshot v1` script only.
- Block commands run as real detached child processes; their stdin is fed from pastes. `format` returns the last written fixture or child output.
- `stopServer` makes every call fail with exit 1 and stderr `connection refused`.

- [ ] **Step 1: Write the failing tests:**
  - `it("every rex invocation carries --autostart=false and --timeout 10s")`: call each exported function against the fake. Assert every logged argv contains both flags.
  - `it("a stopped server raises RexUnavailableError, a hung one RexTimeoutError")`. Make the fake hang via `FAKE_REX_HANG=1`, with a 1 s timeout override for the test.
  - `it("rexApi passes JSON params as one argv element")`: params `{"text":"a b $X \"q\""}` round-trip unchanged.
  - `it("no test file runs a real rex binary")`: scan `test/*.test.mjs` for `execFileSync("rex"` or `spawn("rex"`, except via PATH under `isolateRex`.
- [ ] **Step 2: Run them.** Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/rexCli.ts` and the fake.
- [ ] **Step 4: Capture fixtures (manual, on real Rex, in a throwaway session):**
  1. `rex new hive-fixture --json`.
  2. Run `claude` in a block. For each state (idle, typing unsubmitted text, permission dialog), capture `block.method com.superlogical.terminal.format {"format":"vt"}` to the fixture files.
  3. Capture Codex idle the same way.
  4. `rex kill hive-fixture`.
  5. Scrub any path or name.
  6. The README records the Rex version, the Claude Code version and the date.
- [ ] **Step 5: Verify.** Run `npm run build && node scripts/run-tests.mjs test/rex-cli.test.mjs`. Expected: PASS.
- [ ] **Step 6: Commit** with the message `rex CLI wrapper, fake rex, captured Rex screens`.

### Task 5: Rex core pane operations and ownership

**Files:**
- Modify: `src/tmux.ts`. Additive only: `export` `classifyInputBox`, `findInputBox`, `findCodexPromptBox`, `classifyCodexInputBox`, and add `inputBoxSnapshotFromRaw(raw: string): InputBoxSnapshot`, `claudeTrailerViewFromRaw(raw: string)`, `paneChoiceCheckFromRaw(raw: string)`, `codexInputBoxStateFromRaw(raw: string, title: string | null)`, `codexTrailerViewFromRaw(raw: string)` and `codexPaneChoiceCheckFromRaw(raw: string, title: string | null)`. The existing target-taking functions call these. No behaviour change.
- Modify: `src/terminal.ts` (Rex branches), `src/terminal/rex.ts`
- Test: `test/rex-core.test.mjs`, `test/rex-ownership.test.mjs`, `test/rex-parsers.test.mjs`

**Interfaces:**
- Produces, in `src/terminal/rex.ts`:
  - `rexSendText(target, text, opts)` and `rexSendKey(target, key)`. Map `Enter`→`enter`, `Escape`→`escape`, `C-c`→`ctrl+c`, `Tab`, `BTab`, `Up`/`Down`. Confirm the names with `rex send-key --help`.
  - `rexCapture(target: string, lines: number, styled: boolean): string`. Uses `terminal.format` with `vt` or `plain`, `max_bytes = lines * 512`, plus `blob_read` for the tail, trimmed to `lines`.
  - `rexTitle(target): string | null`
  - `rexProbe(target): { live: Liveness; pid: string | null; argv: string | null; exited: boolean }`
  - `rexSnapshot(): RexSnapshot | null`, one `rexLua(SNAPSHOT_SCRIPT)` call
  - `rexOwnership(row: RowPaneIdentity, snap?: RexSnapshot | null): RowOwnership`
  - `rexStop(target, timeoutMs): void` and `rexClose(target): void`
- In `src/terminal.ts`: `interface TerminalSnapshot extends AliveSnapshot { rex?: RexSnapshot | null }`. `liveTargets()` returns tmux's snapshot plus `rex` when `rexInUse()`.
- `RexSnapshot` is `{ answered: boolean; blocks: Map<string, { pid: string; argv: string; exited: boolean; status: ProgramStatus | null; subagents: number; window: string; session: string }> }`, where `ProgramStatus` is `{ state: string; kind: string | null; msg: string | null }`.
- Grace: kv `terminal:rex:unreachable-since:<server>` is set on the first failed snapshot and cleared on success. `rexOwnership` returns `"unknown"` while unreachable for under `REX_UNREACHABLE_GRACE_MS = 600_000`, and `"gone"` after.
- `callerPane()` returns `REX_BLOCK` when the resolved terminal is Rex. `callerSocket()` returns `rex:` + `defaultRexServer()`.

- [ ] **Step 1: Write the failing parser test** `test/rex-parsers.test.mjs`: `it("Rex vt captures classify the same as their tmux counterparts")`. For each Rex fixture, assert that `inputBoxSnapshotFromRaw` gives the state listed in the fixture README: idle→`empty`, typing→`human-text`, dialog→`paneChoiceCheckFromRaw().awaitingChoice === true`. Use the existing state names from `InputBoxState`. Also run the existing `test/fixtures/panes/` corpus through the `FromRaw` variants, to prove there is no tmux regression. If `vt` output needs normalising, add `normalizeRexVt(raw): string` in `src/terminal/rex.ts` and test it here.
- [ ] **Step 2: Write the failing core tests** `test/rex-core.test.mjs`, against the fake:
  - `it("paste carries metacharacters and 20k chars intact")`: a body of `` $HOME & "q" `x` `` plus newlines plus 20,000 `a`. The fake records the paste event text. Assert equality and exactly one trailing `enter` key.
  - `it("unsafe control char is refused before any rex call")`: the call log is empty.
  - `it("capture is tail-bounded on a block with 5MB scrollback")`: the result has at most N lines, and `max_bytes` was passed.
  - `it("block moved to another session is still live and receives text")`: `fakeRexDo(transferWindow)`, then `sendText`. Assert the paste landed.
  - `it("copy mode is always false on Rex")`.
- [ ] **Step 3: Write the failing ownership tests** `test/rex-ownership.test.mjs`:
  - `it("live when pid and argv match")`.
  - `it("reissued when the block runs a different pid")`.
  - `it("exited block reads gone after its final screen is captured")`.
  - `it("closed block reads gone and cancels its wake")`: spawn a fake worker row through the MCP server, `wake_set` to it, `fakeRexDo(closeBlock)`, then one scheduler tick. Assert the wake status is cancelled and exactly one dead-process notice exists.
  - `it("unreachable server holds for the grace window then reads gone")`: `stopServer`. Assert `unknown` and the wake held. Advance kv `unreachable-since` by 601 s. Assert `gone`.
  - `it("one snapshot spawn per liveTargets call regardless of block count")`: 6 blocks give 1 logged `do` call.
- [ ] **Step 4: Run them.** Expected: FAIL.
- [ ] **Step 5: Implement** the `src/tmux.ts` additive exports first, and run the full suite. Expected: green, with no tmux change. Then implement `src/terminal/rex.ts` and the facade branches. Sessions are resolved per call with `target.resolve` and never stored (§6.2).
- [ ] **Step 6: Verify.** Run `npm run build && npm test`. Expected: green.
- [ ] **Step 7: Commit** with the message `Rex pane operations and ownership`.

### Task 6: Rex lead and worker creation

**Files:**
- Modify:
  - `src/terminal/rex.ts`
  - `src/spawn.ts` (`placeAgentPane`: one early-return line to Rex)
  - `src/cli.ts` (`cmdLead` lead creation and adoption: one branch line)
  - the worker brief builder in `src/brief.ts` (one line, Rex workers only)
- Test: `test/rex-spawn.test.mjs`

**Interfaces:**
- Consumes: `resolveTerminal` and `terminalOfRow` (Task 3); `rexApi` (Task 4); `rexProbe` (Task 5).
- Produces, in `src/terminal/rex.ts`:
  - `rexEnsureHome(projectId: number, projectName: string): { session: string; window: string }`. kv `terminal:rex:window:<project_id>` is verified with `target.resolve`. If it's missing, hive creates the tab in the session of `REX_BLOCK`, or in the session labelled `sessionName()`, creating that session if needed. It never renames.
  - `rexCreatePane(spec: RexPaneSpec): { target: string; socket: string; pid: string; window: string }`
  - `type RexPaneSpec = { projectId: number; projectName: string; label: string; cwd: string; env: Record<string, string>; argv: string[]; placement: "lead" | "split" | "window" | "hidden"; beside?: string; retainOnExit: boolean; size?: { columns: number; rows: number } }`
- Block options:
  - `shell: "none"`
  - `command: ["env", ...K=V, ...argv]`
  - `exit: { on_completion: !retainOnExit }`
  - `size` copied from the lead block's `terminal.size`
  - label `<project>/<agent>`
- `withWindowClaim` wraps `rexEnsureHome` + `rexCreatePane`, just as it wraps tmux window creation.
- After the first Rex pane is created, write kv `terminal:rex:in-use`.
- A quick-failure exit (`last_exit` set within 1 s): capture the screen into the spawn error, then `rexClose`.
- Brief line, Rex workers only: `Do not create, close, move or rename Rex blocks, windows or sessions; ask your lead.`

- [ ] **Step 1: Write the failing tests:**
  - `it("hive lead under Rex creates one labelled tab per project and records block:/rex: on the lead row")`.
  - `it("second hive lead for the same project adopts the live lead block")`.
  - `it("hive lead inside Rex uses the caller's session and never renames it")`: set the fake's `REX_BLOCK` inside session `user-session`. Assert no `session.set_label` call.
  - `it("agent_spawn under a Rex lead splits beside the lead and resizes nothing else")`: assert the call log has one `new_split` anchored on the lead and zero `resize_pane`.
  - `it("placement window opens a tab in the lead's session")`.
  - `it("worker env reaches the program through the env prefix")`: assert `HIVE_AGENT_ID` and `HIVE_PROJECT_LOCK=1` in the child's environment.
  - `it("a worker that dies within 250ms reports its screen and leaves no block")`.
  - `it("Rex worker brief forbids touching Rex blocks; tmux brief does not")`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Build the argv from the same inputs `workerCommandString` uses, as an array, not a shell string.
- [ ] **Step 4: Verify.** Run `npm run build && npm test`. Expected: green.
- [ ] **Step 5: Commit** with the message `Rex leads and workers`.

### Task 7: Lead handoff on Rex

**Files:**
- Modify: `src/terminal/rex.ts`. The facade's `respawnPane` from Task 2 gets a Rex branch.
- Modify, only where a check keys on an unchanged target: `src/leadHandoffCli.ts`, `src/leadHandoff.ts`, `src/scheduler.ts` (`leadBootSessionIsFresh`)
- Test: `test/rex-handoff.test.mjs`

**Interfaces:**
- Produces: `rexRespawn(old: string, spec: RexPaneSpec): { target: string; pid: string }`. In order:
  1. `new_block`, detached and sized to the old block;
  2. `move_block` with the old block as anchor;
  3. the caller records the new target and pid in one transaction (`leadHandoffCli.ts` already receives the target from Task 2);
  4. `rexClose(old)`.

- [ ] **Step 1: Invoke `hive-internals`** for worker-state and tmux-and-panes. List every check that compares the handoff's `pane_target` or `predecessor_pane_pid` with the lead row, then note in the PR which ones need a Rex case.
- [ ] **Step 2: Write the failing tests:**
  - `it("handoff on Rex moves the lead row to a new block in the old block's place")`: assert the row target changed, the old block is closed, and the new block sits in the same window and position as the old one.
  - `it("wakes and standing watches to the lead survive a Rex handoff")`.
  - `it("crash between move and close leaves an orphan that doctor reports")`: kill the respawn after step 2, using fake hook `FAKE_REX_FAIL_ON=block.close`.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Verify.** Run `npm run build && npm test`. Expected: green, and the existing handoff tests are unchanged.
- [ ] **Step 6: Commit** with the message `Lead handoff on Rex`.

### Task 8: Processes and `hive layout` on Rex

**Files:**
- Modify: `src/processes.ts` (Rex stop branch), `src/cli.ts` (`cmdShow`/`cmdHide` for processes, `hive layout`: Rex branches), `src/terminal/rex.ts`
- Test: `test/rex-processes.test.mjs`

**Interfaces:**
- Produces:
  - `rexStopProcess(target, timeoutMs)`: `ctrl+c`, then `rex wait --for` exit, then `rexClose`.
  - `rexFloatHidden(target, leadTarget)`: `float_block` into the lead's window, `set_layer_state minimized`, then resize to the lead's size.
  - `rexUnfloat(target, leadTarget, placement)`
  - `rexApplyLayout(window, layout: WindowLayout)`, which rebuilds the split tree from the lead plus visible blocks. It is called only by `hive layout`.
- `visible: false` processes use `rexFloatHidden`.

- [ ] **Step 1: Write the failing tests:**
  - `it("visible:false process is a minimized float in the lead's tab")`.
  - `it("hive stop on Rex sends ctrl+c, waits, then closes")`.
  - `it("hive layout on Rex is the only path that resizes")`: spawn 2 workers, assert 0 `resize_pane`, run `hive layout`, assert at least one.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run `npm run build && npm test`. Expected: green.
- [ ] **Step 5: Commit** with the message `Rex processes and layout`.

### Task 9: Worker visibility toggle

**Files:**
- Modify: `src/cli.ts` (`cmdShow`/`cmdHide` accept worker names and `--all`; new `cmdPeek`; command list and help), `src/help.ts`, `src/spawn.ts` (`workers: hidden` → placement `hidden`)
- Test: `test/rex-visibility.test.mjs`

**Interfaces:**
- Consumes: `rexFloatHidden` and `rexUnfloat` (Task 8).
- Produces CLI commands:
  - `hive hide <worker|process> [--all]`
  - `hive show <worker|process> [--all]`
  - `hive peek <worker>`: `set_layer_state normal` + focus.
- Name resolution: processes first (the current behaviour), then workers. If one name matches both, refuse with `ambiguous: <name> is both a process and a worker`.
- `show` for `placement: window` creates a placeholder block in a new tab in the lead's session, moves the worker in beside it, then closes the placeholder.
- Hiding a worker on tmux is refused: `hiding workers needs terminal: rex`.

- [ ] **Step 1: Write the failing tests:**
  - `it("workers: hidden spawns a minimized float in the lead's tab")`.
  - `it("hide then show returns the worker to the lead's split")`.
  - `it("hide --all and show --all cover every running worker and no process")`.
  - `it("peek restores and focuses without moving the worker into the split")`.
  - `it("hidden placement:window worker floats in the lead's tab and show gives it a new tab")`.
  - `it("hiding a worker on tmux is refused with the Rex hint")`.
  - `it("hide on a hidden worker says already hidden and makes no rex call")`.
  - `it("wakes deliver to a hidden worker")`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run `npm run build && npm test`. Expected: green, and the existing process show/hide tests are unchanged.
- [ ] **Step 5: Commit** with the message `Worker visibility toggle on Rex`.

### Task 10: Attach, `hive next`, and the queen across terminals

**Files:**
- Modify: `src/cli.ts` (attach, lead, next, queen: the Rex branch of `attachInteractive`/`focus`), `src/terminal/rex.ts`
- Test: `test/rex-attach-queen.test.mjs`

**Interfaces:**
- Produces: `rexFocus(target): { focused: boolean; selected: boolean; hint: string }`. Calls `session.focus_block`, then a best-effort `client.perform` of `session.select` for that session. `hint` is `Rex session <label>, tab <label>`. When `selected` is false, the CLI prints the hint and exits 0.

- [ ] **Step 1: Write the failing tests:**
  - `it("hive attach on Rex focuses the lead and selects its session")`.
  - `it("hive attach with no Rex client prints the session and tab and exits 0")`: the fake's `client.perform` returns `not_found`.
  - `it("hive lead --detach on Rex prints LEAD_PANE=block: and focuses nothing")`.
  - `it("a Rex queen delivers agent_send to a tmux lead and a tmux queen to a Rex lead")`: one store with 2 projects, one per terminal, and a queen row. Assert both messages land, and that each call log has only its own terminal's calls.
  - `it("hive next picks and focuses a Rex project's lead")`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run `npm run build && npm test`. Expected: green.
- [ ] **Step 5: Commit** with the message `Rex attach, hive next, queen across terminals`.

### Task 11: Survive a Rex restart

**Files:**
- Create: `src/rexResume.ts`
- Modify: `src/cli.ts` (hidden commands `__rex-launch`, `__rex-resume`; `hive setup --rex-resume` prints the `init.lua` trust rule), `src/terminal/rex.ts` (`rexCreatePane` wraps the argv in `hive __rex-launch <agent_id> --`)
- Test: `test/rex-resume.test.mjs`

**Interfaces:**
- Consumes: `resumeWorker` (`src/agentResume.ts`), lead re-point logic from `cmdLead`.
- Produces:
  - `rexLaunch(agentId: number, argv: string[]): never`. Emits OSC 7577 with the command `hive __rex-resume <agent_id>`. The record must be authenticated with `OSC7577_TOKEN`; the format is in the Rex docs (`build/program-resume.md`). It then deletes `OSC7577_TOKEN` from the environment and execs argv.
  - `rexResume(agentId: number): never`. It checks that `REX_BLOCK` equals the row's `tmux_target` and that the row is `running` or recovery-`pending`. On success it records the new pid and `pane_started_at`, rebuilds the launch through `resumeWorker`/lead re-point, and execs it with full hive env. On any failure it prints `hive: not resuming <name>: <reason>` and execs the user's shell.
  - `REX_RESUME_TRUST_RULE: string`: the `init.lua` snippet. hive never writes `init.lua`.

- [ ] **Step 1: Read the Rex program-resume doc** (`https://www.superlogical.com/rex/docs/build/program-resume.md`) and record the record format and token rules in the PR.
- [ ] **Step 2: Write the failing tests:**
  - `it("hive panes never expose OSC7577_TOKEN to the harness")`: the fake sets `OSC7577_TOKEN=t`. The fake claude dumps its env. Assert it is absent.
  - `it("rex launch emits one resume record naming hive __rex-resume <id>")`.
  - `it("__rex-resume restores a worker with HIVE_AGENT_ID and HIVE_PROJECT_LOCK")`: use `fakeRexDo(restartServer)`, which keeps block ids, kills the children and re-runs the recorded commands. Assert the row is live with the new pid and the env is present.
  - `it("__rex-resume for a closed row or a different block refuses and runs a shell")`.
  - `it("without the trust rule, restored blocks are shells and their rows are reaped")`: `restartServer` with `trust=false`.
  - `it("hive setup --rex-resume prints the rule and writes nothing")`: the fake home's `init.lua` is unchanged.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Manual check on real Rex** (throwaway session; record the result in the PR):
  1. Install the trust rule.
  2. Start a lead and a worker.
  3. `rex server stop`, then reopen Rex.
  4. Check that both come back with hive identity (`agent_status`).
  5. Confirm the block ids are the same.
  6. If the ids change, stop and report: §6.10 step 4 needs a re-point by label.
- [ ] **Step 6: Verify.** Run `npm run build && npm test`. Expected: green.
- [ ] **Step 7: Commit** with the message `Rex restart survival with hive identity`.

### Task 12: Program-status holds

**Files:**
- Modify: `src/scheduler.ts` (`deliverable()`: one added clause), `src/leadMessageDelivery.ts` (same hold), `src/terminal.ts`
- Test: `test/rex-status-hold.test.mjs`

**Interfaces:**
- Consumes: `TerminalSnapshot.rex.blocks.get(target).status` (Task 5).
- Produces: `programStatusBlocks(target: string, snap: TerminalSnapshot | null): boolean`. True iff the status `state` is `blocked`, or `kind` is in `["permission", "question", "auth"]`. Always false for tmux targets or a null status.
- The hold reuses `HELD_REASON_MODAL_CHOICE`. `wakeSql.ts` is not changed.

- [ ] **Step 1: Manual check** (throwaway session): trigger a Claude permission dialog in a Rex block and read `program_status`. Record the observed `state`/`kind` in the PR. If Claude emits no `blocked`, the clause stays in, the tests still pin it, and the PR says it is inert for Claude today.
- [ ] **Step 2: Write the failing tests:**
  - `it("Rex blocked status holds a wake even when the screen scrape says clear")`.
  - `it("Rex idle status never releases a scrape-detected dialog hold")`.
  - `it("tmux rows ignore program status")`.
  - `it("agent_send to a blocked Rex lead is held, not typed")`.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Verify.** Run `npm run build && npm test`. Expected: green, and the existing hold tests are unchanged.
- [ ] **Step 6: Commit** with the message `Hold delivery when Rex reports a blocked program`.

### Task 13: Ports for processes

**Files:**
- Modify: `src/processes.ts` (wait for `wait_for_port`), `src/cli.ts` (`hive status`/`hive start` output), `src/dashboard.ts` (ports column), `src/terminal/rex.ts`
- Test: `test/rex-ports.test.mjs`

**Interfaces:**
- Produces:
  - `rexPorts(target): { port: number; address: string }[] | null`, from `terminal.ports`. Null on tmux or on failure.
  - `waitForPort(target, want: number | true, timeoutMs = 60_000): boolean`
- In `hive start` output: `<name>: started (ports 3000, 9229)`, or `<name>: started; port 3000 not listening after 60s`.
- On tmux, `wait_for_port` warns once with `wait_for_port needs terminal: rex; ignoring` and does not wait.

- [ ] **Step 1: Write the failing tests:**
  - `it("hive start waits for wait_for_port and prints the ports")`.
  - `it("wait_for_port timeout reports and leaves the process running")`.
  - `it("wait_for_port true waits for any port")`.
  - `it("wait_for_port on tmux warns and does not wait")`.
  - `it("dashboard shows a process's listening ports on Rex")`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run `npm run build && npm test`. Expected: green.
- [ ] **Step 5: Commit** with the message `Process ports on Rex`.

### Task 14: Subagent display

**Files:**
- Modify: `src/tools/agents.ts` (`agent_status`/`agent_list` summary field), `src/cli.ts` (`hive status`), `src/dashboard.ts`, `src/terminal/rex.ts` (the snapshot carries child record titles)
- Test: `test/rex-subagents.test.mjs`

**Interfaces:**
- Produces: the summary field `subagents: { count: number; titles: string[] } | null`. Null on tmux. Titles are capped at 5 entries of 80 chars each.
- `agent_status` declares an `outputSchema`, so the field goes into that schema (`tool-contract.md`: always a JSON object).

- [ ] **Step 1: Write the failing tests:**
  - `it("agent_status shows live subagent count and titles for a Rex worker")`.
  - `it("subagents is null for tmux workers")`.
  - `it("titles are capped at 5 and 80 chars")`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run `npm run build && npm test`. Expected: green.
- [ ] **Step 5: Commit** with the message `Show Rex subagents in status`.

### Task 15: Subagent latch release (gated by design review)

**Files:**
- Create: `docs/superpowers/specs/2026-11-25-rex-subagent-latch-review.md`
- Modify (only if the review approves): `src/backgroundTasks.ts` and the `src/hook.ts` stop path
- Test: `test/rex-subagent-latch.test.mjs`

**Interfaces:**
- Consumes: the snapshot's `subagents` and root `status` (Task 5).
- Produces, if approved: `rexSubagentsSettled(target, stopAt: string, snap): boolean`. True iff a snapshot taken after `stopAt` shows 0 child records and the root state is `idle` or `done`.

- [ ] **Step 1: Write the review.** Invoke `hive-internals` (worker-state). Write the review doc arguing §6.11 Use 2 against `.claude/rules/worker-state.md` ("a latch may decide whether to LOOK, never what is true"). Cover the crash case, a second concurrent subagent, and a snapshot older than the Stop. Conclude approve or reject.
- [ ] **Step 2: Stop for the user.** Comment on the issue with the review link and wait for the user's approval before Step 3. If it's rejected, close the issue as `not planned`.
- [ ] **Step 3: Write the failing tests:**
  - `it("Rex worker with open background_tasks goes idle once children are gone after the Stop")`. Assert over the `agent_state_log` sequence, not `agents.agent_state`.
  - `it("a snapshot older than the Stop never releases the latch")`.
  - `it("children still present keeps the latch until 15 minutes")`.
  - `it("tmux workers keep the 15-minute latch")`.
- [ ] **Step 4: Run them.** Expected: FAIL.
- [ ] **Step 5: Implement.**
- [ ] **Step 6: Verify.** Run `npm run build && npm test`. Expected: green.
- [ ] **Step 7: Commit** with the message `Release the subagent latch on Rex evidence`.

### Task 16: `hive doctor`, docs, and fork agent instructions

**Files:**
- Modify: `src/cli.ts` (doctor: the Rex section, with the tmux checks gated), `src/sessionProbe.ts` (only if doctor's per-project probe needs the terminal)
- Create: `docs/rex.md`
- Modify: `README.md` (one docs-table row), `CLAUDE.md` (a "Fork: terminal seam" section of at most 10 lines: the facade rule, the seam guard, and the merge recipe `git fetch upstream && git merge upstream/main`, after which both suites must pass)
- Test: `test/rex-doctor.test.mjs`

**Interfaces:**
- Doctor Rex lines (§5.6), each `ok`/`warn`/`fail`:
  - `terminal: rex (from <source>)`
  - `rex: <path>`
  - `rex server: reachable, version V, api_revision N (minimum M)`
  - `rex blocks: K owned, G rows gone, O orphan blocks`
  - `rex resume rule: installed|missing`
  - `rex session naming hook: off|ON (workers may rename your session)`
- `REX_MIN_API_REVISION = 24` in `src/terminal/rex.ts`.

- [ ] **Step 1: Write the failing tests:**
  - `it("doctor reports the Rex section when terminal is rex")`.
  - `it("doctor skips tmux-only checks with no tmux rows under rex")`.
  - `it("doctor names orphan hive-labelled blocks with no row")`.
  - `it("doctor warns when api_revision is below the minimum")`.
  - `it("doctor on tmux prints no Rex section and makes no rex call")`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement doctor.** Write `docs/rex.md`, covering:
  - turning Rex on;
  - the layout;
  - hide, show and peek;
  - restart survival setup;
  - what doesn't apply from `docs/tmux.md`;
  - attention indicators.

  Cite `file:line` per `test/docs.test.mjs`.
- [ ] **Step 4: Verify.** Run `npm run build && npm test`. Expected: green, including `test/docs.test.mjs` and `test/comment-ratio.test.mjs`.
- [ ] **Step 5: Commit** with the message `Rex doctor, docs, fork seam instructions`.

### Task 17: Live Rex check and a day of use

**Files:**
- Create: `scripts/rex-live-check.mjs`
- Test: the script itself (opt-in, never CI)

**Interfaces:**
- `HIVE_TEST_LIVE_REX=1 node scripts/rex-live-check.mjs` uses a scratch `HIVE_DATA_DIR` and a session named `hive-live-<pid>`, which it destroys in `finally`. It refuses to run if a session with that name exists. It never touches any other session.

- [ ] **Step 1: Write the script.** It runs, in order:
  1. create the session;
  2. `hive lead --detach`;
  3. spawn 2 workers;
  4. `agent_send`;
  5. hide, peek and show;
  6. a handoff;
  7. a status hold (if Task 12 Step 1 found `blocked` is emitted);
  8. `hive doctor`;
  9. destroy the session.

  It prints PASS/FAIL per step and exits non-zero on any FAIL.
- [ ] **Step 2: Run it on real Rex.** Expected: every step PASS. Attach the output to the PR.
- [ ] **Step 3: Day of use.** Set `hive setup --terminal rex` and work one real day. File each defect as its own issue labelled `rex-backend`. Close this issue once a day passes with no blocking defect.
- [ ] **Step 4: Commit** with the message `Live Rex check script`.

---

## Dependency order

```
1 → 2 → 3 → 4 → 5 → 6 ─┬→ 7
                        ├→ 8 → 9
                        ├→ 10
                        ├→ 11
                        ├→ 12
                        ├→ 13
                        └→ 14 → 15
7..15 → 16 → 17
```

Tasks 7, 8, 10, 11, 12, 13 and 14 can run in parallel once Task 6 is merged. Task 9 needs Task 8. Task 15 needs Task 14 and the user's approval.
