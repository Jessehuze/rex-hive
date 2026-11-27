import { getProject } from "./context.js";
import type { ProcessSnapshot, WorkerSubagents } from "./dashboard.js";
import { db } from "./db.js";
import { loadProjectYml } from "./projectYml.js";
import { closeAgentRow, currentOwnership, killAgentPane, paneIdentity, relayoutAfterPaneLeft } from "./spawn.js";
import { rexAwaitPorts, rexStopProcess, rexVisibilityAndPorts, rowServer, type RexPort } from "./terminal/rex.js"; import { rexCloseRetiled } from "./rexRetile.js";
import {
  sessionName,
  type AliveSnapshot, type RowOwnership,
} from "./tmux.js"; import {
  paneVisibility,
  paneWindow,
  projectWindows, interruptPane,
  cancelCopyMode,
  observeRowOwnership,
  paneProcessExited,
  rowLive, isRexTarget, rowSubagents,
} from "./terminal.js";

// One derivation for every surface that reports where a project's processes are: `hive status`,
// `hive doctor`, and the dashboard. Two tmux window lookups per project, then one per running
// process, and none at all for a project with neither a running command nor a defined one.
export function snapshotProcesses(projectId: number): ProcessSnapshot[] {
  const rows = runningCommandRows(projectId);
  const project = getProject(projectId);
  const defined = project ? Object.keys(loadProjectYml(project.path).config?.processes ?? {}) : [];
  if (rows.length === 0 && defined.length === 0) return [];

  const windows = rows.length > 0 ? projectWindows(sessionName(), projectId) : null;
  const running = new Set(rows.map((r) => r.name));
  return [
    ...rows.map((r) => {
      if (isRexTarget(r.tmux_target)) {
        const { visibility, ports } = rexVisibilityAndPorts(r.tmux_target, rowServer(r.tmux_socket, r.tmux_target) ?? undefined);
        return { name: r.name, running: true, visibility, startedAt: r.created_at, ...(ports ? { ports: portNumbers(ports) } : {}) };
      }
      return {
        name: r.name,
        running: true,

        // A row recorded on a socket this process cannot see into reads as unknown, never as a
        // location: the pane id would name whatever holds it on THIS server.
        visibility: windows !== null && rowLive(r.tmux_socket, r.tmux_target) === true ? paneVisibility(r.tmux_target, windows) : null,
        startedAt: r.created_at,
      };
    }),
    ...defined
      .filter((name) => !running.has(name))
      .map((name) => ({ name, running: false, visibility: null, startedAt: null })),
  ];
}

export function workerSubagents(projectId: number, snapshot: AliveSnapshot | null | undefined): Map<number, WorkerSubagents> {
  const shown = new Map<number, WorkerSubagents>();
  if (!snapshot || !(snapshot as { rex?: unknown }).rex) return shown;
  const rows = db
    .prepare("SELECT id, tmux_target, tmux_socket FROM agents WHERE project_id = ? AND status = 'running' AND kind != 'command'")
    .all(projectId) as { id: number; tmux_target: string; tmux_socket: string }[];
  for (const row of rows) {
    const subagents = rowSubagents(row, snapshot);
    if (subagents) shown.set(row.id, subagents);
  }
  return shown;
}

const portNumbers = (ports: RexPort[]): number[] => [...new Set(ports.map((p) => p.port))].sort((a, b) => a - b);

export const WAIT_FOR_PORT_TIMEOUT_MS = 60_000;
export const WAIT_FOR_PORT_ON_TMUX = "wait_for_port needs terminal: rex; ignoring";

function waitForPortTimeoutMs(): number {
  const raw = Number(process.env.HIVE_WAIT_FOR_PORT_TIMEOUT_MS);
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, WAIT_FOR_PORT_TIMEOUT_MS) : WAIT_FOR_PORT_TIMEOUT_MS;
}

export function awaitStartedPorts(row: Pick<StoppableRow, "tmux_target" | "tmux_socket">, want: number | true): string {
  const timeoutMs = waitForPortTimeoutMs();
  const wait = rexAwaitPorts(row.tmux_target, want, timeoutMs, rowServer(row.tmux_socket, row.tmux_target) ?? undefined);
  const what = want === true ? "any port" : `port ${want}`;
  if ("ports" in wait) return ` (ports ${portNumbers(wait.ports).join(", ")})`;
  if (wait.stopped === "exited") return `; exited before ${what} was listening`;
  if (wait.stopped === "unsupported") return `; Rex cannot list ports, so ${what} was not waited for`;
  const after = `after ${Math.round(timeoutMs / 1000)}s`;
  return want === true ? `; no port listening ${after}` : `; port ${want} not listening ${after}`;
}

export const COMMAND_KIND = "command";

export const STOP_GRACE_MS = 2000;

// The closed set docs/projects.md's "Lifetime" section is checked against (test/docs.test.mjs):
// every way a hive.yml process can be stopped, named once here and rendered by whoever prints it.
export const STOP_REASONS = {
  byHand: "hive stop",
  leadSessionEnded: "lead session ended",
  leadPaneExited: "lead pane exited",
  previousLead: "left running by a previous lead",
} as const;

export type StopReason = (typeof STOP_REASONS)[keyof typeof STOP_REASONS];

export type StopLeg = "interrupted" | "killed" | "already-gone" | "unreachable" | "still-running";

export interface StoppedProcess {
  name: string;
  leg: StopLeg;
  note?: string;
}

export type StartResult =
  | { status: "started"; message: string }
  | { status: "already-running"; location: "shown" | "hidden" | null }
  | { status: "refused"; reason: "reserved-name" | "untrusted" | "escaped-dir" | "unknown-liveness"; message?: string }
  | { status: "failed"; message: string };

export function renderStart(result: StartResult): string {
  switch (result.status) {
    case "started":
      return result.message;
    case "already-running":
      return `already running${result.location ? ` (${result.location})` : ""}`;
    case "refused":
      return result.message ?? "";
    case "failed":
      return `failed: ${result.message}`;
  }
}

export interface StoppableRow {
  id: number;
  project_id: number;
  name: string;
  tmux_target: string;
  tmux_socket: string;
  pane_pid: string;
  created_at: string;
}

const STOPPABLE_COLUMNS = "id, project_id, name, tmux_target, tmux_socket, pane_pid, created_at";

export function runningCommandRows(projectId: number): StoppableRow[] {
  return db
    .prepare(
      `SELECT ${STOPPABLE_COLUMNS} FROM agents
       WHERE project_id = ? AND status = 'running' AND kind = 'command' ORDER BY created_at`,
    )
    .all(projectId) as StoppableRow[];
}

export function runningCommandRow(projectId: number, name: string): StoppableRow | undefined {
  return db
    .prepare(
      `SELECT ${STOPPABLE_COLUMNS} FROM agents
       WHERE project_id = ? AND name = ? AND status = 'running' AND kind = 'command'`,
    )
    .get(projectId, name) as StoppableRow | undefined;
}

export const STOPPING_MARKER_TTL_SECONDS = 30;

export const stoppingMarkerKey = (agentId: number): string => `stopping:${agentId}`;

// Written BEFORE the pane is touched and read by the janitor's sweep. Ordering alone used to carry
// "this process died on its own", and it could not: an interrupted stop left a closed row over a
// live process, invisible to every surface, and the next start doubled it (todo 765, measured).
function markStopping(projectId: number, agentId: number): void {
  try {
    db.prepare(
      `INSERT INTO kv (project_id, key, value, updated_by, expires_at)
       VALUES (?, ?, '"stopping"', 'hive', datetime('now', printf('+%d seconds', ?)))
       ON CONFLICT(project_id, key) DO UPDATE SET
         value = excluded.value, updated_at = datetime('now'), expires_at = excluded.expires_at`,
    ).run(projectId, stoppingMarkerKey(agentId), STOPPING_MARKER_TTL_SECONDS);
  } catch {

  }
}

export function stoppingMarkerLive(projectId: number, agentId: number): boolean {
  try {
    return !!db
      .prepare(
        `SELECT 1 FROM kv WHERE project_id = ? AND key = ?
          AND (expires_at IS NULL OR expires_at >= datetime('now'))`,
      )
      .get(projectId, stoppingMarkerKey(agentId));
  } catch {
    return false;
  }
}

function clearStoppingMarker(projectId: number, agentId: number): void {
  try {
    db.prepare("DELETE FROM kv WHERE project_id = ? AND key = ?").run(projectId, stoppingMarkerKey(agentId));
  } catch {

  }
}

const STOP_POLL_MS = 50;

function waitForPaneToExit(target: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (paneProcessExited(target) === true) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(STOP_POLL_MS, remaining));
  }
}

const UNKNOWN_OWNERSHIP_NOTE =
  "its pane ownership is unknown (no pane pid recorded, a legacy window target, or another tmux socket), so hive left it running";
const REISSUED_NOTE = "its pane id now belongs to another process, which was left alone";
const CHANGED_NOTE =
  "its row was closed or recorded a different pane during the stop, so hive touched nothing further";

// Unknown, or a row that changed underneath the stop, is left running: closing it would hide a
// process that may still be running from every surface that reports one.
function notOwned(row: StoppableRow, ownership: Exclude<RowOwnership, "live"> | "changed"): StoppedProcess {
  if (ownership === "unknown") return { name: row.name, leg: "unreachable", note: UNKNOWN_OWNERSHIP_NOTE };
  if (ownership === "changed") return { name: row.name, leg: "unreachable", note: CHANGED_NOTE };
  closeAgentRow(row.id, paneIdentity(row));
  return { name: row.name, leg: "already-gone", ...(ownership === "reissued" ? { note: REISSUED_NOTE } : {}) };
}

// The only thing that stops a hive.yml command. kill-pane alone is SIGHUP, which a dev server with
// detached grandchildren survives while still holding its port, so the graceful leg comes first and
// the receipt says which one ended it.
// `reason` is deliberately not read here and is not carried on the receipt: it is a required
// argument so every caller has to declare its trigger from the closed set docs/projects.md is
// checked against, and whichever caller prints it already knows which one it passed.
export function stopProcess(row: StoppableRow, reason: StopReason): StoppedProcess {
  const identity = paneIdentity(row);
  const ownership = observeRowOwnership(identity);
  if (ownership === "probe-failed") return { name: row.name, leg: "unreachable" };
  if (ownership !== "live") return notOwned(row, ownership);

  markStopping(row.project_id, row.id);
  if (isRexTarget(row.tmux_target)) return stopRexProcess(row, identity, reason);
  const window = paneWindow(row.tmux_target);
  const beforeSignal = currentOwnership(row.id, identity);
  if (beforeSignal !== "live") {
    clearStoppingMarker(row.project_id, row.id);
    return notOwned(row, beforeSignal);
  }
  try {

    // In copy mode C-c is `cancel`, not SIGINT, so the graceful leg would silently do nothing to a
    // pane someone scrolled back in. A stop may take that scrollback position: the process is ending.
    cancelCopyMode(row.tmux_target);
    interruptPane(row.tmux_target);
  } catch {

  }
  let leg: StopLeg = "interrupted";
  if (!waitForPaneToExit(row.tmux_target, STOP_GRACE_MS)) {
    const beforeKill = currentOwnership(row.id, identity);
    if (beforeKill !== "live") {
      clearStoppingMarker(row.project_id, row.id);
      return notOwned(row, beforeKill);
    }
    try {
      killAgentPane(row.tmux_target);
    } catch {

    }
    leg = waitForPaneToExit(row.tmux_target, STOP_GRACE_MS) ? "killed" : "still-running";
  }

  // The row closes only once the pane is confirmed gone. A stop that did not finish leaves the row
  // RUNNING, so the process stays visible to hive status, hive stop and the janitor.
  if (leg === "still-running") return { name: row.name, leg };
  closeAgentRow(row.id, identity);
  clearStoppingMarker(row.project_id, row.id);
  relayoutAfterPaneLeft(window);
  return { name: row.name, leg };
}

const REX_UNREACHABLE_NOTE = "Rex could not be reached during the stop, so hive left it running";

const LEAD_ENDING: StopReason[] = [STOP_REASONS.leadSessionEnded, STOP_REASONS.leadPaneExited];

function stopRexProcess(row: StoppableRow, identity: ReturnType<typeof paneIdentity>, reason: StopReason): StoppedProcess {
  const beforeSignal = currentOwnership(row.id, identity);
  if (beforeSignal !== "live") {
    clearStoppingMarker(row.project_id, row.id);
    return notOwned(row, beforeSignal);
  }
  let stopped: { exited: boolean; gone: boolean };
  try {
    const stop = () => rexStopProcess(row.tmux_target, STOP_GRACE_MS, rowServer(row.tmux_socket, row.tmux_target) ?? undefined);
    stopped = LEAD_ENDING.includes(reason) ? stop() : rexCloseRetiled(row.tmux_target, stop);
  } catch {
    return { name: row.name, leg: "unreachable", note: REX_UNREACHABLE_NOTE };
  }
  if (!stopped.gone) return { name: row.name, leg: "still-running" };
  closeAgentRow(row.id, identity);
  clearStoppingMarker(row.project_id, row.id);
  return { name: row.name, leg: stopped.exited ? "interrupted" : "killed" };
}

export function stopAllProcesses(projectId: number, reason: StopReason): StoppedProcess[] {
  return runningCommandRows(projectId).map((row) => stopProcess(row, reason));
}

export function stopLine(stopped: StoppedProcess): string {
  switch (stopped.leg) {
    case "interrupted":
      return `${stopped.name}: stopped (C-c)`;
    case "killed":
      return `${stopped.name}: stopped (killed after ${STOP_GRACE_MS / 1000}s)`;
    case "already-gone":
      return stopped.note
        ? `${stopped.name}: already gone (${stopped.note})`
        : `${stopped.name}: already gone (nothing was running)`;
    case "unreachable":
      return stopped.note
        ? `${stopped.name}: ${stopped.note}`
        : `${stopped.name}: tmux could not be probed, so hive left it running`;
    case "still-running":
      return `${stopped.name}: still running: its pane survived C-c and kill-pane, so hive left the row open`;
  }
}
