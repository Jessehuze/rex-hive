# Design review: releasing the subagent latch on Rex evidence (§6.11 Use 2)

Status: review, awaiting the maintainer's decision. Date: 2026-11-26. Reviews §6.11 "Use 2, the latch" of `2026-11-25-rex-terminal-backend-design.md` against `.claude/rules/worker-state.md` and its `hive-internals` reference. Use 1 (display) is not under review.

**Conclusion: REJECT Use 2. Ship Use 1 alone.** Rex evidence stays display-only and never writes `agents.agent_state`. One report-only follow-up is described at the end. It is optional, and it would ship off.

## 1. What Use 2 proposes

For a Rex row whose last Stop reported an open background subagent, hive writes `idle` early when a snapshot taken after that Stop shows zero `program_status` child records and the root record is `idle` or `done`. The spec justifies this in two sentences. The first is "records drop when their process exits". The second is "it only releases a hold that the latch itself would release at 15 minutes anyway".

## 2. Both premises are false

**There is no 15-minute release for a Claude worker.** `waitingOnSubagents` (`src/hook.ts`) has two branches:

- When the Stop payload carries `background_tasks`, which Claude's always does, the latch is `liveBackgroundTasks(...).some(withholdsIdle)`. That check has no age bound. The row is written `working` and stays `working` until the next hook event.
- `SUBAGENT_LATCH_MAX_AGE_SECONDS` bounds only the other branch, `hasOpenSubagent`. That branch reduces `subagent_start`/`subagent_stop` log rows and is reached only by Codex, whose Stop carries no `background_tasks`.

What happens at 15 minutes for a Claude worker is a **report**. `noteStalledCrew` (`src/scheduler.ts`) and `reportStalledWorkers` (`src/cli.ts`) fire on `STALL_BOUND_SECONDS`, and only if the transcript is also stale. Neither writes state.

So the two paths are mismatched. The path with a time release (Codex) has no Rex evidence, because Codex's `program_status` emission is unknown (§6.9). The path with Rex evidence (Claude) has no time release. Use 2 would not deliver "an earlier instance of an already-accepted outcome", which is the argument the worker-state reference used to accept the Codex window's residual. It would be a new outcome: the first writer of `agent_state` other than the hook. Today only `applyWorkerTransition` (`src/hook.ts`) writes it, plus spawn's reset to `unknown`.

**The absence of a child record does not prove a subagent ended.** In a real run (Rex with Claude Code 2.1.332), a running subagent's child record disappeared for about 25 seconds while that subagent waited on a background shell it had launched. The record then came back. This happened to two subagents in one run (call this A2). "Zero children" is therefore an inference from absence, and it has already been seen false.

## 3. Use 2 against the rule

`worker-state.md`: *a latch may decide whether to LOOK, never what is true. Deciding to STAY QUIET is the safe direction of the same rule.*

Use 2 decides what is true, and it decides it in the unsafe direction. Writing `idle` makes a standing watch report a finish. A lead acts on a finish, often by reviewing or tearing the worker down. A false idle while a subagent is still running gets that subagent's work thrown away. A late idle costs a stall notice, which exists to make the lead look. The worker-state reference records this asymmetry twice: in the todo 468 decision not to widen the latch, and in the transcript-mtime measurement where latch age was wrong three times in four. Use 2 trades the cheap error for the expensive one.

The spec's defence is that this is "evidence from the process layer, not a latch". That holds for the root state, which is Claude's own report of its turn. It does not hold for the children. Their count is a sampled absence, and A2 shows the sample can be wrong for tens of seconds.

## 4. The cases

**What Use 2 buys, given the observed lifecycle (A3).** Claude launched a background subagent and ended its turn. The Stop carried `background_tasks: [{type: "subagent", status: "running"}]`. For the subagent's whole life, Rex kept the ROOT at `working`, never `idle` or `done`. When the subagent finished, its child record dropped. Claude then took its own task-notification turn: a `prompt`, then a Stop with `background_tasks: []`. Only after that Stop did the root go to `done`.

So in the normal case, Use 2's condition becomes true at the same moment the hook writes `idle` anyway, and it cannot become true earlier. It buys nothing there. It differs from today only when no follow-up Stop arrives, and in that case Claude's own reporting has already failed. Use 2 would then ask the same process's other channel to be right, which is weakest evidence exactly where it would be used.

**Crash.** A dead Claude is a liveness question. The janitor already answers it: the pane's pid changes or the block goes, and the row is closed as `reissued` or `gone`. Use 2 cannot help either way:

- If Rex clears the dead owner's records, the root is null and the condition (root `idle`/`done`) is false.
- If Rex leaves stale records, the last root state was `working` (A3), and the condition is false.

Rex is documented to clear `program_resume_records` about 2 s after the owner pid exits. For `program_status` this is **unverified**. Agent subagents are believed to run inside the Claude process, so one should not outlive its parent. A background shell can outlive it, but a shell never latches. This is also **unverified** for the Rex block's view.

**Second concurrent subagent.** The Stop reports A and B. A finishes. Claude takes a notification turn, and that turn's Stop still lists B, so the hook correctly keeps the row `working`. Under Use 2, a release now depends on B's child record staying visible. A2 says it may not. Use 2 is safe here only if the root stays `working` through B's vanished-record gap. A3 showed the root `working` while a child was present. **No one has observed the root's state during an A2 gap.** Child records also cover background shells (flat ids such as `bmno4m7zd`, beside `a…`-prefixed subagent ids). So "zero children" mixes a type that latches with types that deliberately never latch. The only thing that tells them apart would be an undocumented id shape.

**A snapshot older than the Stop.** The batched snapshot carries no capture time today (`RexSnapshot`, `src/terminal/rex.ts`). The Stop's time is a seconds-granularity `datetime('now')`. A build would have to stamp the snapshot when the request starts, not when it finishes, and require that stamp to be strictly later than the Stop by at least one second of granularity. It would also have to stop the scheduler from reusing a tick's cached snapshot. Even then, "after the Stop" is not "after the subagent ended": in A3 the first post-Stop snapshots show the child present and the root `working`. The freshness rule is necessary but not sufficient, and it adds a timing guard to a path the scheduler must never throw on.

**A root with no state.** `readStatus` (`src/terminal/rex.ts`) defaults a root record's missing `state` to `"idle"`. That is harmless for display. For Use 2 it would turn a missing field into the very fact the release keys on. A build would have to read the raw field.

**Where the brief puts the code.** The brief names the `src/hook.ts` stop path. But at Stop time the subagent is running, and by A3 the root is `working` and the child is present, so the condition can only become true later. The release would have to live in the scheduler as a polled, non-hook write of `agent_state`. That is the exact shape the "enumerate every writer" rule warns about. It also needs a synthetic `agent_state_log` event, and every finish-suppressing and "already reported" reader would have to be checked against it (the resumed-worker lesson). A late real Stop that follows would also write a second `idle` episode.

## 5. Decision

REJECT. The three strongest reasons:

1. For Claude, the only harness Rex reports subagents for, there is no 15-minute release to bring forward. Use 2 would be a new, non-hook writer of `idle`, not an earlier instance of an accepted outcome.
2. Its key input, "zero children", has been observed false for about 25 s while a subagent ran (A2). A false idle is the expensive direction: a finish notice the lead acts on.
3. Given A3, it changes nothing in the normal case. It differs only when Claude has already failed to send its follow-up Stop, and in that case the stall report already tells the lead to look.

No narrowed form keeps a release and survives point 2. A dwell long enough to cover A2 would be a debounce, which is legitimate. But it would still be releasing on the stretch of time the observed gap shows we cannot bound.

**Optional follow-up, report-only, off by default.** When the stall report fires for a Rex row whose last Stop listed a live subagent, the notice could add what Rex currently shows: "Rex shows no subagents and the root idle since HH:MM", or the live titles. That helps the lead decide whether to look. It writes no state and moves no timing. It must ship behind a key that is absent by default, because it changes an existing notice's text.

## 6. Tests

If Use 1 ships alone, pin the rejection so a later change cannot quietly reverse it:

- `it("Rex evidence never writes agent_state: a Stop with a running subagent stays working whatever the snapshot shows")`. Assert over the `agent_state_log` sequence: no row whose event is not a hook event.
- `it("the Claude subagent latch has no age bound; SUBAGENT_LATCH_MAX_AGE_SECONDS bounds only the log-derived path")`.

If the maintainer overrides this review and builds Use 2, it needs at least:

- `it("Rex worker with open background_tasks goes idle once children are gone after the Stop")`. Assert over the `agent_state_log` sequence, including the synthetic event's name.
- `it("a snapshot older than the Stop never releases the latch")`, with the snapshot started inside the Stop's own second.
- `it("a child record that vanishes while the root is working never releases")` (A2).
- `it("a root record with no state field never counts as idle")`.
- `it("a second subagent still listed by the latest Stop holds the latch after the first ends")`.
- `it("a background shell child does not stand in for a subagent")`, in both directions.
- `it("a real Stop after a Rex release files no second finish")`.
- `it("children still present keeps the latch until the stall report")`. Note that this is a report, not a 15-minute release.
- `it("tmux workers keep today's latch unchanged")`.

## 7. What this review could not settle

These need a real Rex session before anyone revisits Use 2:

- the root's state during an A2 gap;
- whether `program_status` records clear after Claude is SIGKILLed mid-subagent, and how fast;
- whether an interrupt (Esc) during a background subagent ever leaves the root `idle`/`done` with zero children and no follow-up Stop. That is the only case Use 2 changes. If it never happens, Use 2 has nothing to do.
