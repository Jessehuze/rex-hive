# Rex terminal backend for hive: design

Status: draft, awaiting approval. Date: 2026-11-25. Fork: `Jessehuze/rex-hive`, based on upstream hive 1.15.x at `f1ad69f`. Rex checked: `0.1.0-preview.25`, api_revision 24, macOS arm64.

## 1. Intent

hive drives its lead and its Claude/Codex workers as programs in tmux panes. It creates panes, types into them, reads their screens back, and watches them die. This fork adds **Rex** as a second terminal that hive drives the same way, so each lead and worker is a **native Rex block**. A native block can be clicked, resized, floated, hidden and brought back, which a tmux pane drawn inside one Rex block cannot be.

Why: Rex can do things tmux cannot. Native panes come first. Rex also knows what the program inside a pane is doing (program status), and it can bring panes back after a restart. Running tmux inside Rex works today, but it throws all of that away.

Success: hive runs a full working day on Rex with tmux never involved. That covers leads, workers, wakes, messages, lead handoff, processes and the queen. tmux users of the same build see no change at all.

## 2. Goals, non-goals, anti-goals

Goals
- With `terminal: rex`, hive creates, drives, observes and stops every pane it owns as a Rex block.
- tmux remains fully supported and remains the default.
- The fork keeps inheriting upstream hive cheaply. Upstream changes merge with few, small, visible conflicts.
- Worker visibility is a toggle. A project setting decides whether new workers start shown or hidden, and a command flips any worker, or all of them, at any time.
- One store can hold projects on both terminals at once, and the queen reaches across them.
- Use what Rex knows that tmux does not, in this first build:
  - program status as an extra reason to hold a wake (§6.9);
  - surviving a Rex restart with hive identity intact (§6.10);
  - subagent tracking (§6.11);
  - ports for `hive.yml` processes (§6.12).

Non-goals
- Replacing tmux, or proposing this upstream now. It may be offered later, and nothing here may block that.
- Re-creating tmux-only conveniences under Rex: view sessions, iTerm `-CC` control mode, the tmux private-socket guards, copy-mode handling, and the bell and status-line recipes.
- Replacing hive's hook-derived worker state with Rex program status. Rex evidence may only **add** holds, and may only settle the narrow subagent question in §6.11.
- Windows or Linux Rex support beyond what comes for free. Remote Rex hosts (`rex -S HOST`).
- A long-lived `rex events` subscriber. It would be a daemon in all but name, which conflicts with "no daemon" and with "the scheduler stays `unref()`'d". Polling stays.

Anti-goals: any of these is a failure even if the feature works.
- A merge from upstream that succeeds and then breaks at run time without anything flagging it.
- Any change in behaviour for a user who never sets `terminal: rex`.
- New entries in the `MIGRATIONS` array. Fork and upstream would collide permanently.
- Tests that touch the user's live Rex server or session, or start a Rex server.
- Hive moving or resizing panes the user arranged by hand.
- A hive pane that Rex restores without hive's identity and project lock (§6.10).
- Rex code spread through `tmux.ts`, or mixed with tmux logic.

## 3. Constraints

From the project (`CLAUDE.md`, `.claude/rules/*`):
- **New behaviour ships off.** Rex is opt-in, and everything in this document applies only when it is chosen. Worker hiding is opt-in per project.
- **Append-only migrations.** The fork adds none (§6.3).
- **Strict project scoping** and the queen's `QUEEN_REACH` are unchanged. The choice of terminal never widens scope, and a restored pane must not either (§6.10).
- **Untrusted `hive.yml` commands never run.** Rex launches pass through the same trust gate as tmux launches.
- **`execFileSync` argument arrays**, never a shell string, for every `rex` invocation.
- **Comment ceiling of 5% per group** (`test/comment-ratio.test.mjs`).
- **Test isolation** (`test/CLAUDE.md`): tests never reach the live store, the developer's tmux server, or the developer's Rex server (new).
- **The scheduler must never throw** and must stay `unref()`'d. A Rex call that hangs or fails is a bounded, caught failure.
- **Worker state** (`.claude/rules/worker-state.md`): a latch may decide whether to look, never what is true. §6.11 is written against that rule.
- The test suite checks every `file:line` citation in `docs/*.md`. This spec lives in `docs/superpowers/specs/`, outside that glob. New user docs in `docs/*.md` must cite correctly.

From the fork situation:
- Upstream moves fast. It had 75 commits in the last month, and `src/tmux.ts` changed in 4 of them.
- 17 upstream test files read `src/*.ts` and pin exact call shapes. Examples: `test/sender-tag-sites.test.mjs` expects `sendText(row.tmux_target, …` and `test/pane-created-with-its-command.test.mjs` lists every pane-creating site.
- So call sites must keep their shape (§6.1). Upstream tests are not edited.

From Rex. Each item was verified against `rex api describe`, `rex <cmd> --help` and the Rex docs.
- **Environment.** Blocks have no environment option. Commands carry `env K=V …`.
- **Layouts.** There are no built-in layouts. `session.new_window` and `session.new_split` accept a whole layout tree and are all-or-nothing.
- **Metadata.** Blocks and windows carry labels only, up to 128 characters, with no custom metadata.
- **Replacing a block** (`new_block` + `move_block` + `close`) gives a **new block ID**.
- **Exit behaviour:**
  - `exit.on_completion: false` keeps a block open after its program exits.
  - A program that fails within 250 ms leaves its block open regardless.
- **Size.** Blocks start at 80×24 unless `size` is given. A block follows its owning client's size. `rex` CLI calls are not attached clients, so the blocks hive creates start unowned. `terminal.resize` applies at once to an unowned block. Ownership affects size only.
- **Hiding and moving blocks:**
  - `session.float_block` and `session.set_layer_state` (minimized or normal) give floating, minimizable layers inside a window.
  - `session.detach_block` closes the window when it removes the last block.
  - `move_block` needs an anchor block that is already in a window.
- **Focus.** `session.focus_block` changes focus only within its session. Showing a session in the app is the client action `session.select`, sent through `client.perform`, which needs Remote Control turned on.
- **Screen capture.** `terminal.format` returns the screen plus scrollback, up to about 64 MiB. It has no line count. `max_bytes` truncates from the start, and `blob_read(offset)` reads the rest. Styled output is `format: "vt"`.
- **Processes.** `session.list_blocks` returns no process info, so each block's processes need their own `terminal.process` call. `rex do -e '<lua>'` can batch many calls in one spawn and returns JSON.
- **Server start.** `rex` autostarts a server by default. `--autostart=false` and `--timeout` must always be passed.
- **Events.** `rex events` without `-s` carries session-level events only. Block events need `-s` or `--all`.
- **Restarts.** A Rex server restart restores sessions, tabs, panes and labels. A program can register a resume command with OSC 7577, authenticated by `OSC7577_TOKEN`. Rex runs a registered command only if a trust rule in the user's `init.lua` allows it. Claude Code registers itself today through Rex's installed hook. A resumed program gets a fresh terminal environment.
- **Program status.** Claude Code reports program status natively through OSC 7501: state, kind and message, plus one child record per running subagent. The `program_status_changed` event exists.
- **Rex in every worker.** The Rex skill and SessionStart hook reach every Claude process in a Rex block, hive's workers included.

## 4. Approaches considered

A. **A switch layer with one implementation per terminal (chosen).** Rex logic lives in new files. Call sites go through a facade that picks tmux or Rex.
- Trade-off: the most work up front.
- Upstream conflicts land exactly at the switch lines, and the Rex code stays isolated.

B. **Translate tmux commands into Rex.** Emulate tmux's command and format language on top of Rex.
- Trade-off: almost no difference from upstream.
- Rejected: upstream's new tmux usage would merge cleanly and then fail at run time.

C. **`if (rex)` branches inside `tmux.ts`.**
- Trade-off: a smaller change than A.
- Rejected: it puts the fork's diff in upstream's busiest file.

Chosen by the user: **A**.

## 5. User-facing behaviour

### 5.1 Choosing the terminal

The terminal is chosen when a **lead** starts. Resolution, first match wins:
1. `HIVE_TERMINAL=rex|tmux` in the environment of the process that starts the lead (`hive`, `hive lead`, `hive queen`, `hive next`).
2. `terminal:` in the project's `hive.yml`.
3. `terminal:` in hive's global config, set with `hive setup --terminal rex|tmux`.
4. `tmux`.

**Workers, processes and handoff successors follow their lead row's terminal, never the setting.** This answers two questions:
- What happens to a lead already running on tmux when `hive.yml` changes? Its new workers stay on tmux until the lead is restarted.
- Which `HIVE_TERMINAL` applies when an MCP server, rather than the CLI, spawns? Only the lead's matters.

Existing panes are always driven by the terminal recorded in their own row, so changing the setting never strands a running pane.

Unknown values produce a validation warning in the same style as `placement`, and the value is ignored.

### 5.2 Where things appear in Rex

```
Rex session
 ├─ tab "queen"                  hive queen
 ├─ tab "rex-hive"               one tab per project
 │   ├─ lead block
 │   ├─ worker-1 block           placement: split → split beside the lead
 │   ├─ worker-2 block
 │   └─ [minimized float] worker-4   hidden (§5.3)
 └─ tab "rex-hive/worker-3"      placement: window → its own tab
```

**The project's home tab.**
- If hive's kv holds a recorded window for the project and Rex says it still exists, that tab is the home, wherever it now lives.
- Otherwise hive creates it: in the session of the calling block when `hive` runs inside Rex (`REX_BLOCK`), and in a session labelled `hive-main` otherwise (store-tagged as `sessionName()` does today).
- hive never renames a session it did not create.

**`placement: split`** means beside the lead block, wherever the user has moved it. **`placement: window`** means a new tab in the same session as the lead.

**Labels.** Blocks are labelled `<project>/<agent>`, `<project>/lead` or `<project>/<process>`. Labels are for people. hive's database is the source of truth.

**hive re-tiles the lead's tab by default** (maintainer decision 2026-11-27, issue #40; this replaces "hive does not re-tile").
- After a split worker is spawned, resumed or forked, a visible process starts in the split, `hive show` or `hive hide` runs, or `agent_close` or `hive stop` closes a split block, hive re-applies the configured `layout` (default `tiled`) through `rexLayoutPlan`/`rexApplyLayout`.
- It arranges the lead block plus the hive-owned, live, non-floating blocks already in the lead's tab. It never pulls a `placement: window` block into the tab and never touches other tabs. Blocks hive does not own are left out of the arrangement and may be displaced.
- It runs under `withWindowClaim` and is best-effort: errors are swallowed and never fail the spawn or close. The scheduler and janitor never re-tile.
- `retile: false` (project or global `hive.yml`) restores the old behaviour: new splits take space from the lead block only, and hive never resizes or moves any other block outside `hive layout`. tmux ignores the key; it already re-tiles with `select-layout`.
- `hive layout` still applies the configured `layout` on demand, gathering split blocks from every tab.
- Exact tmux geometry is not a goal.

**Attention indicators come free.** Rex marks unfocused tabs and sessions whose programs are working or blocked. That covers what `docs/tmux.md`'s bell and status-line recipe and `allow-passthrough` were for, with no configuration.

### 5.3 Worker visibility toggle (Rex only)

- In `hive.yml`, `workers: shown | hidden` sets how new workers start. Absent means `shown`.
- `hive hide <worker>` and `hive show <worker>` work today only on `hive.yml` process names. They are extended to worker names, with `--all` for every running worker in the project.
- **Hidden means a minimized floating layer in the lead's tab.**
  - A hidden worker stays in a tab, so Rex's working and blocked indicators still show it.
  - It keeps deterministic bounds, because hive sizes the float to the lead block's size with `terminal.resize` or `resize_layer`.
  - A hidden `placement: window` worker floats in the lead's tab too. Its own tab would otherwise vanish when it left.
- **`hive peek <worker>`** restores the layer and focuses it over the lead. Running `hive hide` again re-minimizes it.
- **`hive show`** moves the worker back into the lead's split, or into a new tab for `placement: window`. A new tab works by creating a placeholder block, moving the worker in, then closing the placeholder.
- On tmux, hiding a worker is refused with a clear message.

### 5.4 Attach and focus

- `hive attach`, `hive lead` and `hive next` call `session.focus_block` on the lead.
- They then make a best-effort `client.perform` of `session.select`, so the Rex app switches to that session.
- If Remote Control is off or no client answers, hive prints the session and tab name.
- There are no view sessions, no `-CC` and no auto-open.
- `hive lead --detach` prints `LEAD_PANE=<block id>` and the attach command, and focuses nothing.

### 5.5 The queen

- The queen is the queen-home project's lead, in a `queen` tab.
- Every reach into another project goes through the per-row facade, so a Rex queen works with tmux leads and the reverse.
- Any hive process can drive any Rex row (§6.3).

### 5.6 `hive doctor`

Doctor reports the effective terminal and where it came from. Under Rex it also reports:
- whether `rex` is on PATH, and whether the server is reachable;
- the server's version and api_revision against the minimum hive requires;
- owned tabs and blocks;
- rows whose block is gone;
- orphaned blocks labelled `<project>/…` with no row;
- whether the restart-survival trust rule (§6.10) is installed;
- whether Rex's SessionStart hook has session naming turned on. That would let workers rename the user's session.

tmux-only checks run only when tmux rows exist or tmux is the effective terminal.

## 6. Design

### 6.1 Module layout and the facade

```
src/terminal.ts        facade: same function names and signatures as the tmux.ts pane functions
                       call sites use today; dispatches on the target (block:… → Rex, else tmux)
src/terminal/rex.ts    Rex implementation of each pane operation
src/rexCli.ts          rex invocation: argv arrays, --autostart=false, --timeout, JSON, typed errors,
                       and batched `rex do` Lua scripts
src/rexResume.ts       restart survival entry point (§6.10)
```

**The facade keeps upstream's call shapes.**
- Functions like `sendText`, `capturePane`, `rowOwnership`, `rowLiveProbe`, `targetLive`, `liveTargets`, `panePidForRecord`, `paneInCopyMode`, `pollPaneReadiness` and `waitForPaneInput` keep their names and signatures.
- `src/terminal.ts` exports them. A target starting `block:` routes to Rex, and anything else falls through to the unchanged `tmux.ts` function.
- At most call sites, **only the import path changes**, from `./tmux.js` to `./terminal.js`. The upstream tests that pin call shapes keep passing.

Functions that create panes, or that run a tmux command directly (`split-window`, `kill-pane`, `respawn-pane`, `join-pane`, and the `spawnSync("tmux")` attach), become facade functions taking a backend-neutral spec. These are the roughly 37 direct calls the handoff counted, in `cli.ts`, `spawn.ts`, `tools/agents.ts`, `processes.ts` and `leadHandoffCli.ts`. Their call sites change by one line each.

**Edits to `tmux.ts` are minimal, and they are budgeted.**
- Several screen functions take a target and capture inside themselves: `inputBoxSnapshot`, `claudeTrailerView`, `paneChoiceCheck`, `codexInputBoxState`, `codexTrailerView` and `codexPaneChoiceCheck`.
- Their classifiers are module-private: `classifyInputBox`, `findCodexPromptBox` and `classifyCodexInputBox`.
- The fork adds `export` to those classifiers, or adds small text-taking variants next to them. This is the only `tmux.ts` edit, and it is additive.
- The Rex implementation captures the screen itself and calls the classifiers.

**Environment reads go through the facade too.**
- `TMUX`, `TMUX_PANE`, `TMUX_TMPDIR` and `tmuxSocketPath(process.env…)` are read in `hook.ts`, `context.ts`, `wakeTarget.ts`, `leadHandoffCli.ts`, `leadHandoff.ts`, `spawn.ts`, `scheduler.ts` and `cli.ts`.
- These become `callerPane()` and `callerLocator()`, which return the Rex block (`REX_BLOCK`) and server when inside Rex, and the tmux values otherwise.

### 6.2 Operations

| Operation | tmux (unchanged) | Rex |
|---|---|---|
| ensure the project home | `ensureSession`, `claimInitialWindow` and `createWindow` under `withWindowClaim` | §5.2 resolution; `session.new_window`; same `withWindowClaim` lock |
| create a pane | `split-window` / `new-window` | `new_split` beside the lead, `new_window`, or a float (hidden). The command is an argv array, `env K=V … <cmd>`. `exit.on_completion: false` when hive needs the final screen. `size` is set to the lead block's size |
| send text | bracketed paste, 1022-byte writes | `block.event` paste after `findUnsafeControlChar`. Bracketed-paste mode is checked through `terminal.modes`. Paste is chunked only if measurement shows Claude needs it |
| send a key | `send-keys` | `block.event` key events, from a fixed table of the keys hive sends |
| capture the screen | `capture-pane [-e] -S -N` | `terminal.format` with `vt` when the tmux path uses `-e`, otherwise `plain`. Bounded with `max_bytes` plus a final `blob_read`, then trimmed to the requested line count |
| title | `paneTitle` | `terminal.title` |
| probe a pane | `display-message` | `terminal.process`: child, foreground name and argv, cwd, `last_exit` |
| live snapshot | `list-panes -a`, one call | one `rex do` Lua script that walks the sessions, their blocks, and `process` (plus `program_status`) for each hive-owned block, returning JSON in one spawn |
| interrupt, then close | `C-c`, `kill-pane` | key `ctrl+c`, `rex wait --for` exit with a timeout, then `rex block close` |
| respawn | `respawn-pane -k` | §6.5 |
| hide, show, peek | (processes only) `join-pane` | §5.3 |
| label | `select-pane -T` | `session.set_block_label` |
| layout on request | `select-layout` | rebuild from a `new_split` layout tree |
| focus | attach, switch-client, view sessions | §5.4 |
| copy mode | `#{pane_in_mode}` | always `false` |
| program status | n/a, returns null | `terminal.program_status` (§6.9, §6.11) |
| ports | n/a, returns null | `terminal.ports` (§6.12) |

**Every Rex call resolves its session at call time** with `target.resolve` (kind `session`, query = block id), which searches every session. Block ids are global UUIDs. Sessions are never stored, because a tab can move between sessions (`transfer_window`), and `REX_SESSION` in a long-running program goes stale or is unset.

### 6.3 Store: no new migrations

Rex locators are written into the existing columns:

| Column | tmux row (unchanged) | Rex row |
|---|---|---|
| `agents.tmux_target`, `lead_handoffs.pane_target`, `actors.tmux_pane`, `timers.deliver_pane` | `%12` | `block:<uuid>` |
| `agents.tmux_socket`, `lead_handoffs.tmux_socket` | socket path | `rex:<server url>` |
| `pane_pid`, `predecessor_pane_pid` | pane pid | the pid hive records for the block (§6.4) |

- **How a row's terminal is recognised.** Columns that hold a target identify Rex by the `block:` prefix. Columns that hold a socket identify it by the `rex:` prefix. Tables with no socket column use the target prefix alone.
- **Server URL.** Inside Rex, the URL is `REX_SERVER`. Outside Rex it is the default server address that `rex` resolves, discovered once through `rex server status` or `whoami --json`. That address is a fixed per-user socket path, stable across restarts. Any hive process can drive a Rex row by addressing the row's own server URL.
- **Project tab ids.** These are a tmux window option today (`@hive-project-id`). Here they are kept in kv under `terminal:rex:window:<project_id>` and verified against Rex before use.
- **Column names stay `tmux_*`.** Renaming them would need a migration.
- **Backstop.** A tmux-only code path that reads a Rex row sees a foreign socket and returns `unknown`, which holds rather than cancels.

### 6.4 Pane identity and liveness

Rex block ids are UUIDs and are never reused, so tmux's recycled-pane-id class of bug cannot happen. Ownership states:

| Observation | `rowOwnership` |
|---|---|
| Rex answered, and the block does not exist | `gone` |
| Block exists and `last_exit` is set (held open after exit) | `gone`. hive captures the final screen first, then closes the block |
| Block exists, the program is running, and the recorded pid or foreground argv does not match | `reissued` |
| Block exists, and the pid and argv match | `live` |
| The `rex` call timed out or failed, or the server is unreachable | `unknown` |

**Server unreachable versus server answered.** tmux's "no server running" is an answer, and every row reads `gone`. Rex differs because its server restores blocks after a restart. So:
- An unreachable server is `unknown` for up to a bounded grace window. The working value is 10 minutes, and the builder confirms it.
- After that window, the janitor treats unreachable as `gone` for teardown and reaping, exactly as tmux's answered-empty case does.
- A server that answers after a restart, with restored blocks running new programs, produces `reissued` or `live`, as in the table. §6.10 decides which.

**What the recorded pid is.**
- Blocks are created with `shell: "none"`, so the program is the block's direct child.
- If Rex still interposes a wrapper (`process.child` was `login` in a probe of an ordinary shell block), hive records the foreground pid and argv instead.
- Ownership compares both pid and argv. The builder confirms which field is stable.
- `workerCommandString` returns a shell string. The Rex path builds the argv array from the same inputs instead.

### 6.5 Lead handoff

tmux's `respawn-pane -k` keeps the pane id, and Rex cannot. The Rex respawn works like this:
1. Create the successor as a detached block running the lead command, sized to the predecessor.
2. `move_block` it into the predecessor's position.
3. In one store transaction, update the lead row's `tmux_target` and `pane_pid` and the handoff row.
4. Close the predecessor.

A crash between steps 2 and 4 leaves an orphan block, which doctor reports. The builder must check every check that keys on the target or pid (`paneReissued`, `leadBootSessionIsFresh`, `predecessor_pane_pid`) against a changed target.

### 6.6 Delivery details that change

- **Environment.** `envFlags`, the `-e K=V` list for tmux, becomes the `env` prefix. `envFlagKeys` stays the one list of what is passed.
- **Paste size.** Measure whether one long paste reaches Claude intact, and chunk only if it does not.
- **Bracketed paste.** If `terminal.modes` says bracketed paste is off, hive refuses to paste, as it does today. It never types raw.
- **Quick failures.** A worker whose launch fails within 250 ms leaves its block open. hive captures the screen for the spawn error, then closes the block.
- **Exit detection** stays polled, using the batched snapshot.

### 6.7 Processes (`hive.yml` processes)

- Visible processes follow placement.
- `visible: false` processes are minimized floats in the lead's tab, the same mechanism as hidden workers. They replace the `<project>/processes` tmux window.
- Stopping a process is `ctrl+c`, then `rex wait --for` exit with a timeout, then close.

### 6.8 Failure handling

- Every `rex` call gets `--autostart=false` and a 10 s `--timeout`.
  - A timeout produces `null` liveness and a `RexTimeoutError`, mirroring `TmuxTimeoutError`.
  - hive never starts a Rex server.
- If `rex` is missing, the server is down, or `api_revision` is below the minimum, `hive lead` under Rex refuses. The message names the problem and the way back (`HIVE_TERMINAL=tmux`).
- The scheduler wraps facade calls exactly as it wraps tmux calls today.

### 6.9 Program status as an extra hold

When a Rex row's `program_status` root record reports `blocked`, or a `kind` of `permission`, `question` or `auth`, wake and message delivery **holds** even if screen scraping says the pane is clear.
- It reuses the existing modal-choice hold reason, so nothing new goes into `wakeSql.ts`.
- It can only add holds, never release one.
- Status comes from the same batched snapshot, so it costs no extra spawn.
- tmux rows return null and behave as today.
- The builder must confirm that Claude Code emits `blocked` for its permission and choice dialogs. Only `working` has been observed so far. Codex status emission is unknown. If Codex emits nothing, it behaves as tmux does.

### 6.10 Surviving a Rex restart

**Risk.** Rex restores panes after a restart and re-runs Claude Code's own resume command in a fresh environment. A hive worker restored that way comes back as a live Claude session with the worker's conversation but without `HIVE_AGENT_ID` or `HIVE_PROJECT_LOCK=1`. That breaks strict scoping.

**Design:**
1. **Claude's own resume record is suppressed.** Every hive launch runs through `hive __rex-launch <agent_id>`, which emits hive's own OSC 7577 record and then unsets `OSC7577_TOKEN` before it execs the harness. Claude therefore cannot register its own record for a hive pane. This step alone fixes the risk.
2. **hive's resume command.** That record is `hive __rex-resume <agent_id>`. When Rex runs it after a restart, inside the restored block (`REX_BLOCK` set), it:
   - verifies the row is a running or pending-recovery row for this block;
   - records the new pid as `pane_started_at`;
   - re-enters the resume path in `src/agentResume.ts` with the row's actor, session id, cwd, Codex home, model and launch arguments;
   - execs the harness with full hive identity.

   If verification fails, it prints why and exits, leaving a shell. It never launches an unidentified harness.
3. **Trust rule.** Rex runs a resume command only when a rule in the user's `init.lua` allows it. hive edits `init.lua` only when the user runs `hive setup --rex-resume --install` (or `--uninstall`). It writes the rule between marker lines, replacing an earlier marked block, refuses a `resume.trust.hive` set outside them, validates the edited file with `rex config check <tmp> --json` before renaming it over `init.lua`, and runs `rex config reload`. Bare `hive setup --rex-resume` still only prints the rule. The record and the rule run the pinned dispatcher when it is hive's own and pinned to this build, so a Node upgrade plus `hive setup` leaves the rule valid. Otherwise they fall back to `[node, dist/cli.js]`. `hive doctor` compares the installed rule with the command hive records now and reports it installed, missing or stale. Under Rex, `hive setup` prints the install command when the rule is stale. Residual: a block launched before the command changed keeps its old record, so it resumes only after it is relaunched. Without the rule, restored hive blocks come back as shells, and the janitor reaps their rows as `reissued` or `gone`. That is still safe.
4. **Leads.** The lead is resumed the same way. Rex's restore sets `REX_BLOCK`, and `hive __rex-resume` re-points the lead row to the restored block. This is the same "re-point" `hive lead` does today, applied to the same block id.

The builder must confirm two things: that block ids survive a Rex restart, and that the token-unset step stops Claude from registering.

### 6.11 Subagent tracking

**Problem.** hive learns about a worker's background subagents only from the `background_tasks` field in a Stop payload. It caps how long it trusts that with a 15-minute latch (`SUBAGENT_LATCH_MAX_AGE_SECONDS`, `src/backgroundTasks.ts`), because it cannot see when a subagent actually ends.

**Rex evidence.** `program_status` lists one child record per running subagent, and records drop when their process exits.

**Use 1, display.** `agent_status`, `hive status` and the dashboard show a Rex worker's live subagent count and titles.

**Use 2, the latch.** For a Rex row with a Stop that reported open background tasks, the latch is released early when both hold:
- a fresh snapshot, taken after that Stop, shows zero child records;
- the root record is `idle` or `done`.

This is evidence about what is true, taken from the process layer, not a latch deciding truth. It only releases a hold that the latch itself would release at 15 minutes anyway.

**Its own design review.** Use 2 touches `.claude/rules/worker-state.md`. It is built last, behind its own review of that rule and the `hive-internals` worker-state reference, before code. If that review rejects it, Use 1 ships alone.

### 6.12 Ports for processes

- **Display.** `terminal.ports` on a process's block lists the TCP ports it listens on. `hive status`, `hive start` and the dashboard show them.
- **Waiting.** A new optional process key, `wait_for_port: <number> | true`, makes `hive start` wait, up to a timeout, until that port, or any port, is listening, before it reports the process as started.
- The key is ignored on tmux, with a warning. Absent means no wait, which is today's behaviour.

### 6.13 Workers and Rex's own agent integration

Every Claude worker in a Rex block receives Rex's skill and its "you are in Rex" context, so a worker could split, close or rename blocks.
- The worker brief gains one line: do not create, close, move or rename Rex blocks or sessions. Ask the lead.
- Doctor warns if Rex's hook has session naming enabled.

## 7. Upstream merge strategy

- **New files.** Rex logic lives only in new files (§6.1), plus new tests and a new `docs/rex.md`.
- **Edits to upstream files** are limited to:
  - import-path changes;
  - one-line call-site changes for pane creation and direct tmux commands;
  - the additive exports in `tmux.ts`;
  - config keys in `projectYml.ts` and `globalConfig.ts`;
  - worker support in `hive hide` and `hive show`, plus the new `peek`, `__rex-launch` and `__rex-resume` commands;
  - the hold check in the delivery path;
  - status and ports fields in status output.
- **The seam guard test** fails CI when:
  - a file imports a terminal-touching function from `./tmux.js`, instead of `./terminal.js`, outside an allowlist. The allowlist holds pure helpers such as the parsers, `shellQuote` and the constants;
  - `tmux` or `rex` is executed directly outside `src/tmux.ts`, `src/terminal*` and `src/rexCli.ts`;
  - `TMUX`, `TMUX_PANE`, `TMUX_TMPDIR`, `REX_BLOCK` or `REX_SERVER` is read outside the facade.

  When upstream adds a new pane call or env read, the merge succeeds but CI goes red. It is never silent.
- **Merging.** Upstream is merged, not rebased, into `main` regularly. A merge is done when the full suite and the Rex tests pass.
- **Agent instructions.** The fork's `CLAUDE.md` / `AGENTS.md` gain a short section on the seam rule.

## 8. Testing

- **Existing suite unchanged and green.** It is the regression test for "no change for tmux users". No upstream test is edited.
- **Seam guard** (§7).
- **Fake `rex`.** A small executable put first on PATH. It keeps sessions, windows, blocks, layers, labels, program status and ports in a JSON file in the test's scratch directory. It runs block commands as real child processes, so pids exist, and records every call. It implements the subset of the CLI and `rex do` that `rexCli.ts` uses. It never contacts a real server.
- **Captured fixtures.** The fake cannot prove that `format: "vt"` output matches tmux's `-e` output closely enough for the classifiers. Real Rex captures of Claude and Codex screens are recorded once (§9 step 4) and checked into `test/fixtures/rex/` as parser fixtures. No personal content goes in them.
- **Contract tests.** One test file runs the same assertions against both terminals: tmux on the test's private socket, Rex through the fake.
- **Isolation.** Tests clear `REX_BLOCK`, `REX_SERVER` and `REX_SESSION` unless they point them at the fake. A guard asserts that nothing in the suite runs a real `rex` binary.
- **Live check (opt-in, never CI).** `HIVE_TEST_LIVE_REX=1` runs a script against a throwaway session, which it destroys at the end. The script:
  - creates the throwaway session;
  - spawns a lead and two workers, and sends a message;
  - hides, peeks at and shows a worker;
  - runs a handoff;
  - checks program-status holds;
  - restarts nothing, because the restart check is manual (§9).
- **CI** stays tmux on macOS. The fake-Rex tests run in CI.

## 9. Delivery order

1. Baseline: build, run the suite on tmux, and record which tests start tmux for real.
2. The facade with tmux-only dispatch, the env reads moved behind it, and the seam guard. No behaviour change.
3. The terminal setting (§5.1) and store encoding (§6.3). Rex refuses with "not implemented".
4. `rexCli.ts`, the fake `rex`, and a one-off fixture capture from real Rex (parser compatibility for `vt`).
5. The Rex core: create, send, key, capture, probe, batched snapshot, stop. Workers and leads become usable.
6. Lead handoff, processes, and `hive layout`.
7. Worker visibility: hide, show, peek, and `workers: hidden`.
8. Attach and focus, `hive next`, and the queen across terminals.
9. Restart survival (§6.10), including a manual restart test.
10. Program-status holds (§6.9).
11. Ports (§6.12).
12. Subagent display, then the design review for the latch, then the latch (§6.11).
13. `hive doctor`, `docs/rex.md`, and the fork's `CLAUDE.md` seam section.
14. The live check, then a day of real use.

## 10. Calls made in this design (check while reading)

- Workers follow their lead row's terminal. The setting applies only when a lead starts.
- The home tab is the recorded one if it still exists. `split` means beside wherever the lead is now.
- Any hive process may drive any Rex row through the row's server URL. Sessions are resolved per call and never stored.
- An unreachable Rex server is `unknown` for a 10-minute grace window, then treated as `gone`.
- The facade keeps upstream function names, so most call sites change only their import.
- The program-status hold reuses the modal-choice hold reason.
- A hidden `placement: window` worker floats in the lead's tab.
- Block ownership is ignored, because it affects only size. hive sizes blocks explicitly.

## 11. Left to the builder

- The exact key-event names, and whether paste needs chunking.
- Whether `vt` capture needs a normaliser to match the classifiers' expectations.
- The stable pid field under `shell: "none"`.
- The grace window's exact value.
- The minimum Rex `api_revision`.
- `withWindowClaim` scoping for Rex. The same store lock is expected to be enough.
- Whether Claude emits `blocked` for dialogs, and whether block ids survive restart. Both are verified during their steps.
