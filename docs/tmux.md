# tmux settings for hive

hive configures the tmux windows it creates and sets the options it needs on each one. This file separates the one global recommendation from settings that merely make the workflow pleasant, because hive has no business prescribing your terminal.

Everything here was measured on tmux 3.7b with Claude Code 2.1.221. hive's CI tests the two newest tmux releases, built from source: 3.8 and 3.7c today. The pair is the `tmux` field of the ubuntu legs in `.github/workflows/ci.yml`. The macOS leg installs whatever `brew install tmux` gives, so Homebrew users get the newest release. Where a default surprised us, the measurement is written down next to it.

Almost all of this applies to **raw attach mode** (`hive setup --attach raw`). Under iTerm control mode (`-CC`) iTerm renders tmux windows as native tabs and panes, so it supplies most of this itself.

## Attach mode

Two places decide whether tmux attaches carry iTerm's control mode (`-CC`): your own `hive lead`/`hive attach`, and auto-open (see docs/daily-driver.md). One stored setting controls both:

| `hive setup --attach <mode>` | `hive lead` / `hive attach` | Auto-open |
|---|---|---|
| `auto` (default) | control mode iff your terminal is iTerm | iTerm in control mode, then Terminal |
| `raw` | never control mode | iTerm running a plain `tmux attach`, then Terminal |
| `control` | always control mode | unchanged from `auto` |

`auto` is today's behavior: nothing changes if you never touch this. Prefer tmux's own key bindings over `-CC`'s window management, or want a raw tmux session under any terminal? `hive setup --attach raw`. `hive doctor` reports the effective mode, where it came from, and the settings carried by hive-owned windows.

## What hive needs

hive marks its windows with `@hive-owned` and sets `allow-passthrough all`, `pane-border-status top`, `pane-border-format " #{pane_index} #{pane_title} "`, `monitor-bell on`, and `window-size smallest` on every window it creates, one tmux call after the pane and its process are already live. Panes inherit these from their window, and tmux resolves that inheritance when an option is read rather than when the pane is made, so a pane started before the write still gets the settings. `hive doctor` reports the effective values on hive-owned windows rather than inspecting your global configuration.

Claude Code removes the dim styling from placeholders and suggested next prompts when `NO_COLOR` is set. Hive uses that styling to tell placeholders from typed input, so suggestions can make `agent_send` refuse and wakes hold. Panes inherit their environment from the tmux server, and `hive doctor` warns when the server carries `NO_COLOR` or when a server started from the current shell would pass it to workers. Unset `NO_COLOR` before starting tmux, or clear it from a running server with `tmux set-environment -g -u NO_COLOR`, then restart affected workers.

`window-size smallest` matters once a second terminal is looking at the same session through a view session (see "Every terminal gets its own view onto the same windows" below): tmux's default, `latest`, resizes every window to whoever focused it last, so two clients fight over the size. `smallest` letterboxes a window to the smaller of the two clients' terminals instead, which is a real cost accepted deliberately: the letterboxing is a visible signal that a view session is open, not a bug to fix later.

No tmux configuration is required for hive-owned windows, so raw attach mode needs no global pane-border settings; `allow-passthrough all` remains a global notification recommendation for Claude Code sessions outside them:

```tmux
set -g allow-passthrough all
```

Set `allow-passthrough all` globally if you run Claude Code in any pane hive did not create.

### `allow-passthrough all`

Without this on a pane you get no notifications from Claude Code there. hive sets it on the windows it owns; the global recommendation covers panes hive knows nothing about.

Claude Code's `iterm2` notification channel emits an OSC 9 escape sequence, and when `$TMUX` is set it wraps that sequence in tmux's DCS passthrough (`\ePtmux;...\e\\`). tmux discards the wrapper unless `allow-passthrough` is on. Bare, unwrapped OSC 9 is discarded at every setting, which is why Claude wraps it.

Use `all`, not `on`. Measured, with a pty-captured client and a live control marker so a silent probe failure could not read as a drop:

| `allow-passthrough` | from the visible pane | from a background window |
|---|---|---|
| `off` (the default) | dropped | dropped |
| `on` | reaches the terminal | dropped |
| `all` | reaches the terminal | reaches the terminal |

Under `placement: split` a worker is a pane you are usually not looking at, and under `placement: window` it is a different window entirely, so `on` silences exactly the workers you are not watching.

**A detached session is beyond what this can fix.** A session with no client attached has nowhere to write, so neither the passthrough nor a bell reaches a client attached to a different session. See "Telling you a background project needs you" below.

### `pane-border-status` and `pane-border-format`

hive sets these on its own windows so split workers remain distinguishable.

hive names tmux windows for the project alone (the window holds the lead AND its workers now, not just the lead) and deliberately never names panes. The lead and each worker get a stable Claude session name from `claude --name`, which Claude writes to the terminal title, which tmux records as `pane_title`. Under `placement: split` every worker is a pane in one window, so with `pane-border-status off` (the default) a whole crew reads as one window called by the project's name alone, with no way to tell which pane is which.

Do not try to solve this with `select-pane -T`. hive did consider it and rejected it: the application writes its own title afterwards and wins. Measured again on 2026-08-03, `select-pane -T "hive - worker-1"` held until the pane's Claude session wrote its own OSC 0 title, and then read whatever Claude set.

If `agent_spawn` uses `placement: "window"` against a split `hive.yml`, run `hive layout` to gather live workers into the project's lead window and restore its configured layout. The command leaves unrelated panes in their source windows, so those windows remain until their last pane leaves.

## Suggested

None of this is required. It is what makes a multi-project tmux workflow bearable.

```tmux
set -g detach-on-destroy off
set -g set-titles on
set -g set-titles-string "#W - #T"
```

**`detach-on-destroy off`.** With several projects sharing the one session, exiting a project's lead just closes ITS window; the session survives with every other project's window untouched, and `off` costs nothing there. It still matters for the case that closes the LAST window - a single-project store, or working down to one - which destroys the session with it. The default then detaches you to a bare shell. With `off` your client moves to the most recently used other session instead (a view session, if one happens to be open, otherwise back out of tmux same as before), so losing the last window drops you somewhere sensible rather than out of tmux with no warning.

**`set-titles on`.** tmux never sets the outer terminal's title unless you ask. In a plain attach your terminal tab keeps whatever title it had before you attached.

### Telling you a background project needs you

This is the one that needs both halves, and neither works alone.

```tmux
set -g monitor-bell on
setw -g monitor-activity off
set -g status-right-length 100
if-shell '! tmux show -gv status-right | grep -q window_bell_flag' \
  'set -ga status-right " #{W:#{?window_bell_flag,!#{window_name} ,}}"'
```

Set Claude Code's `preferredNotifChannel` to `iterm2_with_bell`. The OSC 9 half cannot escape a detached session, and the bell is the only part tmux can record.

tmux does record it, per WINDOW: `list-windows` reports `window_bell_flag=1` for whichever window a bell fired in, current or not. It simply never tells a client looking at a different window, so the status line has to ask. The `#{W:...}` loop above renders every window in the shared session that is flagged, by name - which, since every hive window is named for its project, is the project that needs you.

**This is a per-window mechanism now, not per-session, and that is a real change from before.** Every project used to live in its own session, so a session-level `#{S:...}` loop could tell you WHICH project rang by naming the session. Under one shared session (see "One session, one window per project" below) every project's window lives in the identical session, so a session-level indicator can only ever say "something in hive-main needs you" - it has lost the ability to say which. Measured directly, replacing `#{S:...}`/`session_alerts` with `#{W:...}`/`window_bell_flag` above restores exactly that: it names the window, and the window is the project.

Three things went wrong building this, all worth not rediscovering:

- **`status-right-length` defaults to 40.** A theme's own right side can spend most of that, and the indicator is then computed correctly and truncated off the edge. `#{E:status-right}` expanded to `... 04-Aug-26 !hive-main` while the screen showed nothing.
- **`set -ga` is not idempotent.** Every `source-file` appends again, so a reload binding grows the value each time you use it. Hence the `if-shell` guard.
- **`monitor-activity` fires on any output**, so every window doing work flags itself and the indicator becomes noise. Bell only.

## Other considerations

Observations from running hive in raw tmux across two machines. None of this is hive's business; it is here so it is written down somewhere.

**Order matters if you use a theme.** A theme plugin's `run` line sets `status-left`, `status-right` and their lengths when it executes. Anything above that line is overwritten. Keep hive-related settings below it.

**One session, one window per project.** `sessionName()` is `hive-main` (tagged for a non-default store), shared by every project in this store; each project gets its own WINDOW inside it, stamped with `@hive-project-id`. Workers, wake delivery, `hive status` and `hive doctor` all resolve through that stamp, never through a session name, so two projects can share a window name with no correctness cost - only `path` is unique in hive's own project table. You never create the session yourself. `prefix c` gives you a shell to type `hive` into; typed from inside tmux, `hive` selects your project's window in the one shared session rather than creating anything.

**Every terminal gets its own view onto the same windows.** `hive <path>` from outside tmux attaches through its own VIEW SESSION rather than putting a client on the shared base session at all: two clients on one session share a current window and fight over it (measured 2026-08-04), and hive used to decide between the two by reading whether the base already had a client - a read that two terminals starting at the same instant both answered "no" to, landing both of them on the base and recreating the fight. There is no such read now. The first terminal and the fifth take the same path, so the everyday single-terminal case runs the same machinery the side-by-side case does, and one view session per attached terminal is normal rather than exceptional. A view session borrows the base session's windows with its own, independent current-window pointer, and owns no panes of its own. It is destroyed the instant its client detaches (`destroy-unattached`, set in the same tmux invocation that creates it) - close the terminal, or detach, and it is gone; the base session and every pane in it are untouched. `hive doctor` reports, but never kills, a clientless view session that somehow outlived its own client - `destroy-unattached` should already have made that unreachable, so the report is belt-and-braces, not a routine occurrence.

**`prefix c` leaves a shell window behind in whichever project's window you launched from.** A `display-popup` launcher avoids that, because the popup is not a window in any session and closes when its command exits:

```tmux
bind P command-prompt -p "project:" -I "~/Code/" "display-popup -E 'hive %%'"
```

**This is simply correct now, with no caveat.** Under the old per-project-session design this launcher armed the exact bug that started the topology redesign: `$TMUX` is set inside a popup, so `hive` took a `switch-client` path that moved your one client off whatever session it had been on, leaving that session clientless mid-spawn - the origin session's next `agent_spawn` then found no client and popped open an unwanted native window. Under one shared session there is no other session to switch to: `hive` from inside tmux (popup or otherwise) now runs `select-window` in the session you are already attached to, which only moves this client's own current window. Nothing to orphan, measured directly against the current code, not merely reasoned about.

**Windows are picked with `prefix w`, tmux's own default, since windows are projects now.** `choose-tree -Zw` already lists every hive-owned window by its plain project name - no `<project> - lead` suffix to strip, since nothing looks a window up by name anymore and the suffix is gone. No custom binding needed for this.

**Never start the outer tmux with `-L` or a custom `TMUX_TMPDIR`.** hive refuses a private socket paired with the default store, on purpose, and the error is long. Plain `tmux` is correct. The prohibition is in `.claude/rules/tmux-and-panes.md` and the reasoning behind it is in the `hive-internals` skill. A private socket also turns auto-attach off entirely, whatever `hive setup --auto-attach` says and whichever store you are on, and that refusal is silent: the window hive would open gets a fresh shell that inherits nothing from hive, so hive cannot make it land on your private server (same rule, same skill reference).

**Quote a leading `=` in a tmux target.** `tmux kill-session -t =hive-main` breaks in zsh, which expands a leading `=` as a command path. Write `-t '=hive-main'`. The same applies to a view session's own name, `hive-<tag>view-<pid>` - `hive doctor`'s stray-view-session report already prints it quoted.

## What this does not cover

hive never writes to your `~/.tmux.conf` and never sets a global tmux option on your behalf. It only configures windows carrying its own `@hive-owned` marker. `hive setup --attach raw` prints the remaining global recommendation.

hive's own test suite runs against a private tmux socket but still reads your `~/.tmux.conf`, because tmux reads its config when the server starts. A test whose assertions depend on pane geometry states that dependency itself; see `test/layout.test.mjs`.

## Rex

hive can run its leads, workers and processes in Rex blocks instead of tmux panes. tmux stays the default, and nothing in this section changes anything for a setup that never chooses Rex.

### Turning Rex on

The terminal is chosen when a **lead** starts. The first match wins (`resolveTerminal`, `src/terminal.ts:260`):

1. `HIVE_TERMINAL=rex` (or `tmux`) in the environment of `hive`, `hive lead`, `hive queen` or `hive next`;
2. `terminal: rex` in the project's `hive.yml`;
3. `terminal: rex` in hive's global config, set with `hive setup --terminal rex`;
4. `tmux`.

Workers, processes and handoff successors follow their lead row's terminal, never the setting. A lead already running on tmux keeps putting new workers on tmux until it is restarted, and a row is always driven by the terminal it was recorded on, so changing the setting never strands a running pane.

hive never starts a Rex server: every `rex` call carries `--autostart=false` and a 10 second `--timeout`. Before it creates a lead block, `hive lead` asks the server who it is, and refuses when `rex` is missing, the server is down, or the server's `api_revision` is below `REX_MIN_API_REVISION` (`src/terminal/rex.ts:44`). The refusal names the problem and the way back, `HIVE_TERMINAL=tmux` (`rexRefuseLead`, `src/terminal/rex.ts:1005`).

### The layout

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

### Hide, show and peek

- `workers: hidden` in `hive.yml` starts new workers hidden; absent means `shown`.
- `hive hide <worker>` floats a worker as a minimized layer in the lead's tab. It keeps running and receiving wakes, and Rex's working and blocked marks still show it (`rexFloatHidden`, `src/terminal/rex.ts:1179`). A hidden `placement: window` worker floats in the lead's tab too.
- `hive show <worker>` moves it back into the lead's split, or into a new tab for `placement: window` (`rexUnfloat`, `src/terminal/rex.ts:1206`).
- `hive peek <worker>` restores the float over the lead and focuses it, without moving it into the split; `hive hide` minimizes it again (`rexPeekBlock`, `src/terminal/rex.ts:1570`).
- `--all` covers every running worker and no process. On tmux, hiding a worker is refused.

### Restart survival

After a restart, Rex restores blocks and re-runs each program's registered resume command. For a hive pane that must be hive's own resume command, never Claude Code's, or a worker would come back as a live Claude session without its hive identity or project lock.

- Rex runs a resume command only when a rule in your `init.lua` trusts it. hive never edits `init.lua`. The rule hive needs is named `hive`.
- `hive doctor` reports it on the `rex resume rule` line, read from `rex config check` (`resumeRuleInstalled`, `src/rexDoctor.ts:52`).
- Without the rule, restored hive blocks come back as shells, and the janitor reaps their rows. That is safe, but the workers have to be resumed by hand.
- Until this build carries hive's own resume launcher and the setup command that prints the rule, do not restart the Rex server while hive workers are running in it.

### Doctor

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

### What does not apply from the tmux settings above

None of the tmux settings above apply to a Rex row: attach modes and `-CC`, `allow-passthrough`, the pane-border title options, `monitor-bell` and the status-line recipe, the private-socket guards and copy-mode handling. Copy mode reads as always off on Rex.

### Attention indicators

Rex marks unfocused tabs and sessions whose programs are working or blocked. That covers what the tmux bell and status-line recipe were for, with no configuration, and a hidden worker still counts because it floats in the lead's tab.

### MCP fields

`agent_status` and `agent_list` carry a `subagents` field on every row. It is `null` for a tmux row, or when Rex reported nothing, and otherwise `{count, titles}`: the live count of the worker's background subagents and up to five of their titles, from Rex's program status (`rowSubagents`, `src/terminal.ts:301`). `hive status` and the dashboard show the same.

### Known gaps

- **Codex.** No captured Codex screen in Rex's styled (`vt`) format is checked in, so the Codex input-box classifiers have not been checked against a real Rex capture, only through the shared normaliser (`normalizeRexVt`, `src/terminal/rex.ts:221`). Whether Codex emits Rex program status is unverified; if it emits nothing, a Codex row holds wakes exactly as it would on tmux.
- **Crash backstop.** On tmux, a lead pane hive created carries a `pane-exited` hook that stops the project's processes if the lead dies. Rex has no such hook, so processes outlive a Rex lead that dies without its SessionEnd hook. Clear them with `hive stop --all`.
- **The in-use flag.** Once any project uses Rex, a `terminal:rex:in-use` kv entry makes every hive process include Rex in its liveness snapshot. It is released once it is ten minutes old and no running row or pending reap is left on Rex (`rexReleaseInUse`, `src/terminal/rex.ts:687`).

### Fork notes

This terminal is a fork of hive. A few visible lines reach users who never choose Rex, because upstream tests pin them:

- `hive --help` always lists `hive peek`, marked Rex only;
- the `hive init` template always carries the commented `# terminal:` and `# workers:` lines;
- `hive setup` prints a `terminal` line, and doctor's effective-config block a `config terminal` row, only once a terminal has been chosen.
