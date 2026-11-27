# Rex terminal

hive can run its leads, workers and processes in Rex blocks instead of tmux panes. tmux stays the default, and nothing on this page changes anything for a setup that never chooses Rex.

## Turning Rex on

The terminal is chosen when a **lead** starts. The first match wins (`resolveTerminal`, `src/terminal.ts:260`):

1. `HIVE_TERMINAL=rex` (or `tmux`) in the environment of `hive`, `hive lead`, `hive queen` or `hive next`;
2. `terminal: rex` in the project's `hive.yml`;
3. `terminal: rex` in hive's global config, set with `hive setup --terminal rex`;
4. `tmux`.

Workers, processes and handoff successors follow their lead row's terminal, never the setting. A lead already running on tmux keeps putting new workers on tmux until it is restarted, and a row is always driven by the terminal it was recorded on, so changing the setting never strands a running pane.

hive never starts a Rex server: every `rex` call carries `--autostart=false` and a 10 second `--timeout`. Before it creates a lead block, `hive lead` asks the server who it is, and refuses when `rex` is missing, the server is down, or the server's `api_revision` is below `REX_MIN_API_REVISION` (`src/terminal/rex.ts:44`). The refusal names the problem and the way back, `HIVE_TERMINAL=tmux` (`rexRefuseLead`, `src/terminal/rex.ts:1005`).

## The layout

```
Rex session
 ├─ tab "queen"                  hive queen
 ├─ tab "<project>"              one tab per project
 │   ├─ lead block
 │   ├─ worker blocks            placement: split → beside the lead
 │   └─ [minimized float]        a hidden worker
 └─ tab "<project>/<worker>"     placement: window → its own tab
```

- **The home tab.** hive records each project's tab. If Rex says that tab still exists, it is the home, wherever it now lives. Otherwise hive creates it, in the session of the calling block when `hive` runs inside Rex, and otherwise in a session labelled with hive's session name (`homeSession`, `src/terminal/rex.ts:840`). hive never renames a session it did not create.
- **Labels.** Blocks are labelled `<project>/lead`, `<project>/<worker>` or `<project>/<process>`. Labels are for people; the store is the source of truth. `agent_rename` relabels the worker's block (`rexRelabel`, `src/terminal/rex.ts:973`).
- **No re-tiling.** A new split goes beside the lead and takes space from the lead block only. hive never moves or resizes a block you arranged. `hive layout` rebuilds the tab from the configured `layout` only when you run it (`rexApplyLayout`, `src/terminal/rex.ts:1378`).
- **Focus.** `hive attach`, `hive lead` and `hive next` focus the lead block, then ask a connected Rex app to switch to its session. With Remote Control off, or no app answering, hive prints the session and tab to open (`rexFocus`, `src/terminal/rex.ts:1549`). There are no view sessions and no `-CC`; `hive lead --detach` focuses nothing.

## Hide, show and peek

- `workers: hidden` in `hive.yml` starts new workers hidden; absent means `shown`.
- `hive hide <worker>` floats a worker as a minimized layer in the lead's tab. It keeps running and receiving wakes, and Rex's working and blocked marks still show it (`rexFloatHidden`, `src/terminal/rex.ts:1179`). A hidden `placement: window` worker floats in the lead's tab too.
- `hive show <worker>` moves it back into the lead's split, or into a new tab for `placement: window` (`rexUnfloat`, `src/terminal/rex.ts:1206`).
- `hive peek <worker>` restores the float over the lead and focuses it, without moving it into the split; `hive hide` minimizes it again (`rexPeekBlock`, `src/terminal/rex.ts:1570`).
- `--all` covers every running worker and no process. On tmux, hiding a worker is refused.

## Restart survival

After a restart, Rex restores blocks and re-runs each program's registered resume command. For a hive pane that must be hive's own resume command, never Claude Code's, or a worker would come back as a live Claude session without its hive identity or project lock.

- Rex runs a resume command only when a rule in your `init.lua` trusts it. hive never edits `init.lua`. The rule hive needs is named `hive`.
- `hive doctor` reports it on the `rex resume rule` line, read from `rex config check` (`resumeRuleInstalled`, `src/rexDoctor.ts:52`).
- Without the rule, restored hive blocks come back as shells, and the janitor reaps their rows. That is safe, but the workers have to be resumed by hand.
- Until this build carries hive's own resume launcher and the setup command that prints the rule, do not restart the Rex server while hive workers are running in it.

## Doctor

`hive doctor` prints a Rex section when the effective terminal is Rex or any running row is on Rex (`rexDoctorSection`, `src/rexDoctor.ts:173`):

| Line | Means |
|---|---|
| `terminal: rex (from <source>)` | the effective terminal and which rule above chose it |
| `rex: <path>` | where `rex` resolves on PATH; FAIL when it does not |
| `rex server: reachable, version V, api_revision N (minimum M)` | from `rex whoami --json`; FAIL when unreachable, warn when N is below M |
| `rex blocks: K owned, G rows gone, O orphan blocks` | rows whose block is open, rows whose block is gone, and blocks labelled `<project>/…` with no row, each named with the `rex block close` command to clear it |
| `rex resume rule: installed\|missing` | the restart-survival trust rule above |
| `rex session naming hook: off\|ON (workers may rename your session)` | whether Rex's SessionStart hook in a Claude settings file tells agents to name the session after their task (`sessionNamingOn`, `src/rexDoctor.ts:71`); with it ON, every worker may rename your session |
| `rex reap` (info) | pending block reaps whose server has not answered for over 10 minutes, cleared (`rexClearStaleReaps`, `src/terminal/rex.ts:1010`) |

tmux-only checks (the `tmux` version, `NO_COLOR`, scratch tmux servers, sessions, window stamps, view sessions) run only when tmux is the effective terminal or a running row is on tmux. A tmux-only setup's doctor output is unchanged.

The calls doctor makes against a real Rex: `rex --autostart=false --timeout 10s whoami --json`, then `rex … do -e <snapshot script> --json --args <owned blocks>`, then `rex … config check`. The naming hook is read from files, with no `rex` call.

## What does not apply from docs/tmux.md

None of the [tmux settings](tmux.md) apply to a Rex row: attach modes and `-CC`, `allow-passthrough`, the pane-border title options, `monitor-bell` and the status-line recipe, the private-socket guards and copy-mode handling. Copy mode reads as always off on Rex.

## Attention indicators

Rex marks unfocused tabs and sessions whose programs are working or blocked. That covers what the tmux bell and status-line recipe were for, with no configuration, and a hidden worker still counts because it floats in the lead's tab.

## MCP fields

`agent_status` and `agent_list` carry a `subagents` field on every row. It is `null` for a tmux row, or when Rex reported nothing, and otherwise `{count, titles}`: the live count of the worker's background subagents and up to five of their titles, from Rex's program status (`rowSubagents`, `src/terminal.ts:301`). `hive status` and the dashboard show the same.

## Known gaps

- **Codex.** No captured Codex screen in Rex's styled (`vt`) format is checked in, so the Codex input-box classifiers have not been checked against a real Rex capture, only through the shared normaliser (`normalizeRexVt`, `src/terminal/rex.ts:221`). Whether Codex emits Rex program status is unverified; if it emits nothing, a Codex row holds wakes exactly as it would on tmux.
- **Crash backstop.** On tmux, a lead pane hive created carries a `pane-exited` hook that stops the project's processes if the lead dies. Rex has no such hook, so processes outlive a Rex lead that dies without its SessionEnd hook. Clear them with `hive stop --all`.
- **The in-use flag.** Once any project uses Rex, a `terminal:rex:in-use` kv entry makes every hive process include Rex in its liveness snapshot. It is released once it is ten minutes old and no running row or pending reap is left on Rex (`rexReleaseInUse`, `src/terminal/rex.ts:687`).

## Fork notes

This terminal is a fork of hive. A few visible lines reach users who never choose Rex, because upstream tests pin them:

- `hive --help` always lists `hive peek`, marked Rex only;
- the `hive init` template always carries the commented `# terminal:` and `# workers:` lines;
- `hive setup` prints a `terminal` line, and doctor's effective-config block a `config terminal` row, only once a terminal has been chosen.
