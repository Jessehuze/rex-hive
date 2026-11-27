import { basename } from "node:path";
import { cliPath } from "../dispatcher.js";
import {
  defaultRexServer,
  RexError,
  RexUnavailableError,
  rexApi,
  rexKey,
  rexCallerBlock,
  rexLua,
  SNAPSHOT_SCRIPT,
} from "../rexCli.js";
import {
  ENTER_DELAY_MS,
  paneEnvPath,
  sessionName,
  findUnsafeControlChar,
  sleep,
  TEXT_ALLOWED_CONTROL_CHARS,
  type Liveness,
  type RowOwnership,
  type RowPaneIdentity,
  type WindowLayout,
} from "../tmux.js";


export interface RexStore {
  inTransaction?: boolean;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
}

let store: RexStore | null = null;

export function registerRexStore(next: RexStore): void {
  store = next;
}

const sql = (): RexStore => {
  if (store === null) throw new Error("no store is registered for Rex bookkeeping");
  return store;
};

export const REX_UNREACHABLE_GRACE_MS = 600_000;
export const REX_UNREACHABLE_STALE_MS = 120_000;
export const REX_BLOB_MAX_BYTES = 983_040;
export const unreachableSinceKey = (server: string): string => `terminal:rex:unreachable-since:${server}`;
export const REX_SOCKET_PREFIX = "rex:";
export const REX_CAPTURE_BYTES_PER_LINE = 512;

const BLOCK_GONE_CODES = new Set(["not_found", "session_not_found"]);
const WRAPPER_PROGRAMS = new Set(["login"]);
const ENV_PROGRAM = "env";
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const LAUNCH_SHELL = "sh";

export interface ProgramStatus {
  state: string;
  kind: string | null;
  msg: string | null;
}

export interface RexSubagents {
  count: number;
  titles: string[];
}

export const SUBAGENT_TITLES_MAX = 5;
export const SUBAGENT_TITLE_MAX_CHARS = 80;

export interface RexBlock {
  pid: string;
  argv: string;
  programs: string[];
  exited: boolean;
  status: ProgramStatus | null;
  subagents: RexSubagents | null;
  window: string;
  session: string;
  label: string;
  probed: boolean;
}

export interface RexSnapshot {
  answered: boolean;
  server: string;
  incomplete: boolean;
  unreachableSince: number | null;
  blocks: Map<string, RexBlock>;
}

export interface RexProbe {
  live: Liveness;
  pid: string | null;
  argv: string | null;
  exited: boolean;
}

export interface RexSendOptions {
  submit?: boolean;
  onPasted?: () => void;
  onBuffered?: () => void;
  beforePaneWrite?: () => void;
  server?: string;
}

function guarded<T>(read: () => T, failed: T): T {
  try {
    return read();
  } catch {
    return failed;
  }
}

function runningRowServer(target: string): string | null {
  if (store === null || !target) return null;
  const row = guarded(
    () =>
      sql()
        .prepare(
          `SELECT tmux_socket FROM agents WHERE status = 'running' AND tmux_target = ? AND tmux_socket LIKE 'rex:%'
           ORDER BY id DESC LIMIT 1`,
        )
        .get(target) as { tmux_socket: string } | undefined,
    undefined,
  );
  return row ? row.tmux_socket.slice(REX_SOCKET_PREFIX.length) : null;
}

export const serverForTarget = (target: string): string | null => runningRowServer(target) ?? defaultRexServer();

function requireServer(target: string, server?: string | null): string {
  const resolved = server ?? serverForTarget(target);
  if (!resolved) throw new RexUnavailableError("no Rex server is known to this process", "unreachable", "");
  return resolved;
}

export const rowServer = (socket: string, target = ""): string | null =>
  socket.startsWith(REX_SOCKET_PREFIX) ? socket.slice(REX_SOCKET_PREFIX.length) : serverForTarget(target);

const blockGone = (err: unknown): boolean => err instanceof RexError && BLOCK_GONE_CODES.has(err.code);

interface ResolveReply {
  results?: { status?: string; target?: { session_id?: string } | null }[] | null;
}

export function rexSessionOf(server: string, block: string): string {
  const reply = rexApi<ResolveReply>(server, "target.resolve", { kinds: ["session"], queries: [block] });
  if (!Array.isArray(reply.results)) throw new RexError("rex target.resolve printed no results", "bad_output", "");
  const hit = reply.results[0];
  if (hit?.status !== "resolved" || !hit.target?.session_id) {
    throw new RexError(`block ${block} is not open on ${server}`, "not_found", "");
  }
  return hit.target.session_id;
}

function blockMethod<T>(server: string, session: string, block: string, method: string, args: object = {}): T {
  return rexApi<T>(server, "block.method", { session_id: session, block_id: block, method, args });
}

const KEY_NAMES: Record<string, string> = {
  Enter: "enter",
  Escape: "escape",
  "C-c": "ctrl+c",
  Tab: "tab",
  BTab: "shift+tab",
  Up: "up",
  Down: "down",
};
const REX_KEY_NAMES = new Set(Object.values(KEY_NAMES));

export function rexKeyName(key: string): string {
  const mapped = KEY_NAMES[key] ?? (REX_KEY_NAMES.has(key) ? key : null);
  if (mapped === null) throw new RexError(`hive has no Rex key for ${JSON.stringify(key)}`, "bad_request", "");
  return mapped;
}

export function rexSendKeys(target: string, keys: string[], server?: string): void {
  const names = keys.map(rexKeyName);
  const resolved = requireServer(target, server);
  const session = rexSessionOf(resolved, target);
  for (const name of names) rexKey(resolved, target, name, session);
}

export const rexSendKey = (target: string, key: string, server?: string): void => rexSendKeys(target, [key], server);

interface ModesReply {
  modes?: { name?: string; number?: number; set?: boolean }[] | null;
}

export function rexBracketedPaste(server: string, session: string, block: string): boolean {
  const reply = blockMethod<ModesReply>(server, session, block, "modes");
  return (reply.modes ?? []).some((m) => (m.name === "bracketed_paste" || m.number === 2004) && m.set === true);
}

export async function rexSendText(target: string, text: string, opts: RexSendOptions = {}): Promise<void> {
  const unsafe = findUnsafeControlChar(text, TEXT_ALLOWED_CONTROL_CHARS);
  if (unsafe) throw new RexError(`refusing to paste a control character (${unsafe.label}) at index ${unsafe.index}`, "bad_request", "");
  const server = requireServer(target, opts.server);
  const session = rexSessionOf(server, target);
  if (text !== "") {
    if (!rexBracketedPaste(server, session, target)) {
      throw new RexError(`block ${target} has bracketed paste off, so hive will not paste into it`, "conflict", "");
    }
    opts.onBuffered?.();
    opts.beforePaneWrite?.();
    rexApi(server, "block.event", { session_id: session, block_id: target, event: { type: "paste", payload: { text } } });
  }
  try {
    opts.onPasted?.();
  } catch {}
  if (opts.submit ?? true) {
    await sleep(ENTER_DELAY_MS);
    opts.beforePaneWrite?.();
    rexKey(server, target, "enter", rexSessionOf(server, target));
  }
}

const CURSOR_FORWARD = /\x1b\[(\d*)C/g;

export function normalizeRexVt(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "")
    .replace(CURSOR_FORWARD, (_, n: string) => " ".repeat(Math.max(1, Number(n || "1"))));
}

interface FormatReply {
  content?: string;
  id?: number;
  total?: number;
  eof?: boolean;
}

interface BlobReply {
  data?: string;
  id?: number;
  total?: number;
  eof?: boolean;
}

function readForward(server: string, session: string, block: string, id: number, from: number, total?: number): string {
  let text = "";
  let offset = from;
  for (let reads = 0; reads < 64; reads++) {
    const part = blockMethod<BlobReply>(server, session, block, "blob_read", { id, offset, max_bytes: REX_BLOB_MAX_BYTES });
    const data = part.data ?? "";
    text += data;
    offset += Buffer.byteLength(data);
    if (part.eof === true || data === "" || (total !== undefined && offset >= total)) break;
  }
  return text;
}

function readTail(server: string, session: string, block: string, styled: boolean, budget: number): { text: string; cut: boolean } {
  const head = blockMethod<FormatReply>(server, session, block, "format", { format: styled ? "vt" : "text", max_bytes: budget });
  const content = head.content ?? "";
  if (head.id === undefined || head.eof === true) return { text: content, cut: false };
  if (head.total === undefined) return { text: content + readForward(server, session, block, head.id, Buffer.byteLength(content)), cut: false };
  const start = Math.max(0, head.total - budget);
  return { text: readForward(server, session, block, head.id, start, head.total), cut: start > 0 };
}

const blankRow = (row: string): boolean => row.replace(/\x1b\[[0-9;]*m/g, "").trim() === "";

function screenRows(server: string, session: string, block: string): number {
  return guarded(() => blockMethod<{ rows?: number }>(server, session, block, "size").rows ?? 0, 0);
}

export function rexCapture(target: string, lines: number, styled: boolean, server?: string): string {
  const resolved = requireServer(target, server);
  const session = rexSessionOf(resolved, target);
  const want = Math.max(1, screenRows(resolved, session, target) + Math.max(0, lines));
  const { text, cut } = readTail(resolved, session, target, styled, want * REX_CAPTURE_BYTES_PER_LINE);
  const rows = (styled ? normalizeRexVt(text) : text.replace(/\r\n/g, "\n")).split("\n");
  if (cut) rows.shift();
  while (rows.length > 0 && blankRow(rows[rows.length - 1])) rows.pop();
  return rows.slice(-want).join("\n");
}

export function rexTitle(target: string, server?: string): string | null {
  try {
    const resolved = requireServer(target, server);
    const reply = blockMethod<{ title?: string }>(resolved, rexSessionOf(resolved, target), target, "title");
    return reply.title ?? "";
  } catch {
    return null;
  }
}

interface ProcessEntry {
  pid?: number;
  name?: string;
  argv0?: string;
  path?: string;
  invoked_path?: string;
  script?: string;
}

interface ProcessReply {
  child?: ProcessEntry | null;
  foreground?: ProcessEntry | null;
  last_exit?: { exit_code?: number } | null;
}

interface StatusRecord {
  id?: string;
  state?: string;
  kind?: string;
  msg?: string;
  title?: string;
}

const programName = (value: string | undefined): string | null => (value ? basename(value.replace(/^-/, "")) : null);

function programsOf(entry: ProcessEntry | null | undefined): string[] {
  if (!entry) return [];
  return [entry.argv0, entry.path, entry.invoked_path, entry.script].map(programName).filter((n): n is string => !!n);
}

function readProcess(reply: ProcessReply | null | undefined) {
  const child = reply?.child ?? null;
  const foreground = reply?.foreground ?? null;
  const wrapped = child !== null && WRAPPER_PROGRAMS.has(programName(child.argv0 ?? child.name) ?? "");
  const main = wrapped ? (foreground ?? child) : child;
  return {
    pid: main?.pid !== undefined ? String(main.pid) : "",
    argv: main?.argv0 ?? "",
    programs: [...programsOf(main), ...programsOf(foreground)],
    exited: reply?.last_exit !== undefined && reply?.last_exit !== null,
  };
}

const isChild = (r: StatusRecord): boolean => r.id !== undefined && r.id !== null && r.id !== "";

const plainText = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();

function subagentTitle(r: StatusRecord): string {
  const title = typeof r.title === "string" ? plainText(r.title) : "";
  const points = Array.from(title !== "" ? title : plainText(String(r.id)));
  return points.length > SUBAGENT_TITLE_MAX_CHARS ? `${points.slice(0, SUBAGENT_TITLE_MAX_CHARS - 1).join("")}…` : points.join("");
}

const recordsRead = (records: unknown): boolean =>
  Array.isArray(records) || (records !== null && typeof records === "object" && Object.keys(records).length === 0);

function readStatus(reply: { records?: StatusRecord[] | Record<string, never> } | null | undefined) {
  const records = Array.isArray(reply?.records) ? reply.records : [];
  const root = records.find((r) => !isChild(r)) ?? null;
  const children = records.filter(isChild);
  return {
    status: root ? { state: root.state ?? "idle", kind: root.kind ?? null, msg: root.msg ?? null } : null,
    subagents: recordsRead(reply?.records) ? { count: children.length, titles: children.slice(0, SUBAGENT_TITLES_MAX).map(subagentTitle) } : null,
  };
}

export function rexProbe(target: string, server?: string): RexProbe {
  try {
    const resolved = requireServer(target, server);
    const reply = blockMethod<ProcessReply>(resolved, rexSessionOf(resolved, target), target, "process");
    const proc = readProcess(reply);
    return { live: true, pid: proc.pid || null, argv: proc.argv || null, exited: proc.exited };
  } catch (err) {
    return { live: blockGone(err) ? false : null, pid: null, argv: null, exited: false };
  }
}

interface SnapshotEntry {
  session_id?: string;
  window_id?: string;
  label?: string;
  probed?: boolean;
  process?: ProcessReply;
  program_status?: { records?: StatusRecord[] };
}

interface SnapshotReply {
  version?: number;
  incomplete?: boolean;
  blocks?: Record<string, SnapshotEntry> | unknown[];
  result?: unknown;
}

function snapshotBody(value: unknown): SnapshotReply | null {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  const reply = parsed as SnapshotReply | null;
  if (reply?.version === 1) return reply;
  if (reply && reply.result !== undefined) return snapshotBody(reply.result);
  return null;
}

function projectsOnServer(socket: string): number[] {
  return (sql().prepare("SELECT DISTINCT project_id FROM agents WHERE tmux_socket = ?").all(socket) as { project_id: number }[])
    .map((r) => r.project_id);
}

function ownedBlocks(socket: string): string[] {
  return (
    sql()
      .prepare("SELECT DISTINCT tmux_target FROM agents WHERE status = 'running' AND tmux_socket = ? AND tmux_target LIKE 'block:%'")
      .all(socket) as { tmux_target: string }[]
  ).map((r) => r.tmux_target);
}

export function unreachableSince(server: string): number | null {
  if (store === null) return null;
  return guarded(() => {
    const row = sql()
      .prepare("SELECT MIN(CAST(json_extract(value, '$.since') AS INTEGER)) AS since FROM kv WHERE key = ?")
      .get(unreachableSinceKey(server)) as { since: number | null } | undefined;
    return row?.since ?? null;
  }, null);
}

function markUnreachable(server: string): number | null {
  const now = Date.now();
  const upsert = sql().prepare(
    `INSERT INTO kv (project_id, key, value, updated_by) VALUES (?, ?, json_object('since', ?, 'last', ?), 'hive')
     ON CONFLICT (project_id, key) DO UPDATE SET
       value = json_object(
         'since', CASE WHEN ? - CAST(json_extract(kv.value, '$.last') AS INTEGER) > ? THEN ? ELSE CAST(json_extract(kv.value, '$.since') AS INTEGER) END,
         'last', ?),
       updated_at = datetime('now')`,
  );
  for (const project of projectsOnServer(`${REX_SOCKET_PREFIX}${server}`)) {
    upsert.run(project, unreachableSinceKey(server), now, now, now, REX_UNREACHABLE_STALE_MS, now, now);
  }
  return unreachableSince(server);
}

function clearUnreachable(server: string): void {
  sql().prepare("DELETE FROM kv WHERE key = ?").run(unreachableSinceKey(server));
}

function bestEffort(fn: () => void): void {
  try {
    fn();
  } catch {}
}

export function rexSnapshot(server?: string | null, extraBlocks: string[] = []): RexSnapshot | null {
  let resolved: string;
  try {
    resolved = requireServer("", server);
  } catch {
    return null;
  }
  const socket = `${REX_SOCKET_PREFIX}${resolved}`;
  let wanted: string[] = extraBlocks;
  try {
    wanted = [...new Set([...ownedBlocks(socket), ...extraBlocks])];
  } catch {}
  let reply: SnapshotReply | null;
  try {
    reply = snapshotBody(rexLua<unknown>(resolved, SNAPSHOT_SCRIPT, { blocks: wanted }));
  } catch (err) {
    if (err instanceof RexUnavailableError && err.code === "unreachable") {
      let since: number | null = null;
      try {
        since = markUnreachable(resolved);
      } catch {}
      return { answered: false, server: resolved, incomplete: false, unreachableSince: since, blocks: new Map() };
    }
    return null;
  }
  if (reply === null) return null;
  if (store !== null) bestEffort(() => clearUnreachable(resolved));
  const blocks = new Map<string, RexBlock>();
  const entries = reply.blocks && !Array.isArray(reply.blocks) ? Object.entries(reply.blocks) : [];
  for (const [id, entry] of entries) {
    const proc = readProcess(entry.process);
    const status = readStatus(entry.program_status);
    blocks.set(id, {
      ...proc,
      ...status,
      window: entry.window_id ?? "",
      session: entry.session_id ?? "",
      label: entry.label ?? "",
      probed: entry.probed === true && entry.process !== undefined,
    });
  }
  if (store !== null) bestEffort(() => applyResumeAnchors(blocks));
  const incomplete = reply.incomplete === true || missingBlocksStillOpen(resolved, wanted.filter((id) => !blocks.has(id)));
  return { answered: true, server: resolved, incomplete, unreachableSince: null, blocks };
}

export const rexResumedUnderKey = (target: string): string => `terminal:rex:resumed-under:${target}`;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A restored block's process is the user's shell; while the resumed harness under it lives, report the harness.
function applyResumeAnchors(blocks: Map<string, RexBlock>): void {
  const ids = [...blocks.keys()];
  if (ids.length === 0) return;
  const rows = sql()
    .prepare(`SELECT key, value FROM kv WHERE key IN (${ids.map(() => "?").join(", ")})`)
    .all(...ids.map(rexResumedUnderKey)) as { key: string; value: string }[];
  for (const { key, value } of rows) {
    const block = blocks.get(key.slice(rexResumedUnderKey("").length));
    const anchor = guarded(() => JSON.parse(value) as { shell?: unknown; pid?: unknown }, {});
    if (!block || block.exited || typeof anchor.pid !== "string" || block.pid !== anchor.shell || !/^[1-9]\d*$/.test(anchor.pid)) continue;
    if (pidAlive(Number(anchor.pid))) Object.assign(block, { pid: anchor.pid, argv: "", programs: [] });
  }
}

function missingBlocksStillOpen(server: string, missing: string[]): boolean {
  if (missing.length === 0) return false;
  return guarded(() => {
    const reply = rexApi<ResolveReply>(server, "target.resolve", { kinds: ["session"], queries: missing });
    if (!Array.isArray(reply.results)) return true;
    return reply.results.some((r) => r.status === "resolved");
  }, true);
}

export function programWords(words: string[]): string[] {
  if (programName(words[0]) !== ENV_PROGRAM) return words;
  let i = 1;
  while (i < words.length && ENV_ASSIGNMENT.test(words[i])) i++;
  return words.slice(i);
}

const withoutAssignments = (words: string[]): string[] => {
  const rest = programWords(words);
  let i = 0;
  while (i < rest.length && ENV_ASSIGNMENT.test(rest[i])) i++;
  return rest[i] === "exec" ? rest.slice(i + 1) : rest.slice(i);
};

const firstProgram = (segment: string): string | null => programName(withoutAssignments(segment.trim().split(/\s+/))[0]);

function commandHeads(command: string | null | undefined): string[] {
  const text = command?.trim() ?? "";
  if (!text) return [];
  const launched = programName(programWords(commandArgv(text))[0]);
  const segments = text.split(/&&|\|\||;/);
  return [...new Set([launched, firstProgram(text), firstProgram(segments[segments.length - 1])].filter((h): h is string => !!h))];
}

function usableSnapshot(snap: RexSnapshot | null | undefined, server: string, target: string): boolean {
  if (snap === undefined || (snap !== null && snap.server !== server)) return false;
  return snap === null || !snap.answered || snap.blocks.get(target)?.probed !== false;
}

function rowCommand(row: RowPaneIdentity & { command?: string | null }): string | null {
  if ("command" in row) return row.command ?? null;
  if (store === null) return null;
  const found = guarded(
    () =>
      sql()
        .prepare("SELECT command FROM agents WHERE status = 'running' AND tmux_target = ? AND tmux_socket = ? ORDER BY id DESC LIMIT 1")
        .get(row.tmux_target, row.tmux_socket) as { command: string } | undefined,
    undefined,
  );
  return found?.command ?? null;
}

export function rexOwnership(row: RowPaneIdentity & { command?: string | null }, snap?: RexSnapshot | null): RowOwnership {
  if (row.tmux_target === "") return "gone";
  const server = rowServer(row.tmux_socket, row.tmux_target);
  if (!server) return "unknown";
  const observed = usableSnapshot(snap, server, row.tmux_target) ? (snap ?? null) : rexSnapshot(server, [row.tmux_target]);
  if (observed === null) return "unknown";
  if (!observed.answered) return graceExpired(observed, server) ? "gone" : "unknown";
  const block = observed.blocks.get(row.tmux_target);
  if (!block) return observed.incomplete ? "unknown" : "gone";
  if (!block.probed) return "unknown";
  if (block.exited) return "gone";
  if (row.pane_pid === "" || block.pid === "") return "unknown";
  if (block.pid !== row.pane_pid) return "reissued";
  const heads = commandHeads(rowCommand(row));
  const programs = block.programs.filter((p) => p !== ENV_PROGRAM);
  if (heads.length > 0 && programs.length > 0 && !heads.some((h) => programs.includes(h))) {
    return programs.every((p) => p === LAUNCH_SHELL) ? "unknown" : "reissued";
  }
  return "live";
}

function graceExpired(snap: RexSnapshot, server: string): boolean {
  const since = snap.unreachableSince ?? guarded(() => unreachableSince(server), null);
  return since !== null && Date.now() - since >= REX_UNREACHABLE_GRACE_MS;
}

export function rexRowProbe(socket: string, target: string, snap?: RexSnapshot | null): { live: Liveness; pid: string | null } {
  if (target === "") return { live: false, pid: null };
  const server = rowServer(socket, target);
  if (!server) return { live: null, pid: null };
  const observed = usableSnapshot(snap, server, target) ? (snap ?? null) : rexSnapshot(server, [target]);
  if (observed === null) return { live: null, pid: null };
  if (!observed.answered) return { live: graceExpired(observed, server) ? false : null, pid: null };
  const block = observed.blocks.get(target);
  if (!block) return { live: observed.incomplete ? null : false, pid: null };
  if (!block.probed) return { live: true, pid: null };
  return block.exited ? { live: false, pid: null } : { live: true, pid: block.pid || null };
}

export function rexBlockAlive(target: string, snap: RexSnapshot | null | undefined): Liveness {
  if (!snap || !snap.answered) return null;
  const block = snap.blocks.get(target);
  if (!block) return snap.incomplete ? null : false;
  return block.probed ? !block.exited : true;
}

export function rexClose(target: string, server?: string): void {
  const resolved = requireServer(target, server);
  let session: string;
  try {
    session = rexSessionOf(resolved, target);
  } catch (err) {
    if (blockGone(err)) return;
    throw err;
  }
  try {
    rexApi(resolved, "block.close", { session_id: session, block_id: target });
  } catch (err) {
    if (!blockGone(err)) throw err;
  }
}

const REX_STOP_POLL_MS = 100;

function awaitExit(target: string, timeoutMs: number, server: string): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = rexProbe(target, server);
    if (probe.live === false || probe.exited) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(REX_STOP_POLL_MS, remaining));
  }
}

export function rexStopProcess(target: string, timeoutMs: number, server?: string): { exited: boolean; gone: boolean } {
  const resolved = requireServer(target, server);
  try {
    rexSendKey(target, "C-c", resolved);
  } catch (err) {
    if (blockGone(err)) return { exited: true, gone: true };
    throw err;
  }
  const exited = awaitExit(target, timeoutMs, resolved);
  rexClose(target, resolved);
  return { exited, gone: rexProbe(target, resolved).live === false };
}


export function rexFinalScreen(target: string, lines: number, server?: string): string {
  return rexCapture(target, Math.max(lines * 10, 200), false, server).split("\n").filter((row) => row.trim() !== "").slice(-lines).join("\n");
}

export const REX_REAP_MAX_FAILURES = 3;
const REAP_PENDING_PREFIX = "terminal:rex:reap:";

interface PendingReap {
  agent: number;
  target: string;
  server: string;
  failures: number;
}

function captureThenClose(pending: PendingReap, projectId: number, lines: number): void {
  const key = `${REAP_PENDING_PREFIX}${pending.agent}`;
  let screen: string;
  try {
    screen = rexFinalScreen(pending.target, lines, pending.server);
  } catch {
    const failures = pending.failures + 1;
    if (failures <= REX_REAP_MAX_FAILURES) {
      writeKv(projectId, key, JSON.stringify({ ...pending, failures }));
      return;
    }
    screen = "";
  }
  if (screen && store !== null) sql().prepare("UPDATE agents SET exit_tail = ? WHERE id = ? AND exit_tail = ''").run(screen, pending.agent);
  rexClose(pending.target, pending.server);
  if (store !== null) sql().prepare("DELETE FROM kv WHERE project_id = ? AND key = ?").run(projectId, key);
}

export function rexReapExited(
  row: { id: number; project_id: number }, target: string, server: string | null, snap: RexSnapshot | null | undefined, lines = 30,
): void {
  try {
    if (!server) return;
    const seen = snap && snap.answered && snap.server === server ? snap.blocks.get(target) : undefined;
    const exited = seen ? seen.probed && seen.exited : rexProbe(target, server).exited;
    if (!exited) return;
    captureThenClose({ agent: row.id, target, server, failures: 0 }, row.project_id, lines);
  } catch {}
}

export function rexReapPending(snap: RexSnapshot | null | undefined, lines = 30): void {
  if (store === null) return;
  const rows = guarded(
    () => sql().prepare("SELECT project_id, value FROM kv WHERE key LIKE ?").all(`${REAP_PENDING_PREFIX}%`) as { project_id: number; value: string }[],
    [],
  );
  for (const row of rows) {
    try {
      const pending = JSON.parse(row.value) as PendingReap;
      const gone = snap?.answered === true && snap.server === pending.server && !snap.incomplete && !snap.blocks.has(pending.target);
      if (gone) sql().prepare("DELETE FROM kv WHERE project_id = ? AND key = ?").run(row.project_id, `${REAP_PENDING_PREFIX}${pending.agent}`);
      else captureThenClose(pending, row.project_id, lines);
    } catch {}
  }
}

export const REX_SHELL_FLAVOR = "com.superlogical.terminal.shell";
export const REX_IN_USE_KEY = "terminal:rex:in-use";

export function rexReleaseInUse(): void {
  if (store === null) return;
  bestEffort(() =>
    sql()
      .prepare(
        `DELETE FROM kv WHERE key = ? AND updated_at < datetime('now', '-10 minutes')
           AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.project_id = kv.project_id AND a.status = 'running'
                             AND (a.tmux_target LIKE 'block:%' OR a.tmux_socket LIKE ?))
           AND NOT EXISTS (SELECT 1 FROM kv r WHERE r.project_id = kv.project_id AND r.key LIKE ?)`,
      )
      .run(REX_IN_USE_KEY, `${REX_SOCKET_PREFIX}%`, `${REAP_PENDING_PREFIX}%`),
  );
}
export const REX_QUICK_EXIT_MS = 1000;
export const rexWindowKey = (projectId: number): string => `terminal:rex:window:${projectId}`;
export const rexSocketOf = (server: string): string => `${REX_SOCKET_PREFIX}${server}`;

export interface RexPaneSpec {
  projectId: number;
  projectName: string;
  label: string;
  cwd: string;
  env: Record<string, string>;
  argv: string[];
  placement: "lead" | "split" | "window" | "hidden";
  beside?: string;
  retainOnExit: boolean;
  size?: { columns: number; rows: number };
  agentId?: number;
}

export interface RexPlaced {
  target: string;
  socket: string;
  pid: string;
  window: string;
}

export function envFromFlags(flags: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (let i = 0; i + 1 < flags.length; i += 2) {
    if (flags[i] !== "-e") continue;
    const eq = flags[i + 1].indexOf("=");
    if (eq > 0) env[flags[i + 1].slice(0, eq)] = flags[i + 1].slice(eq + 1);
  }
  return env;
}

const SHELL_ONLY = /[;&|<>()$`*?~#{}[\]!\n]/;

export function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === " " || c === "\t") {
      if (word !== null) words.push(word);
      word = null;
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? "") + command.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let text = "";
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === "$" || command[j] === "`") return null;
        if (command[j] === "\\" && '"\\$`'.includes(command[j + 1] ?? "")) j++;
        text += command[j];
      }
      if (j >= command.length) return null;
      word = (word ?? "") + text;
      i = j;
    } else if (c === "\\") {
      if (i + 1 >= command.length) return null;
      word = (word ?? "") + command[++i];
    } else if (SHELL_ONLY.test(c)) {
      return null;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

const SHELL_BUILTINS = new Set(["cd", "source", ".", "export", "set", "unset", "alias", "eval", "ulimit", "umask", "trap", "builtin", "command"]);
export const REX_SHELL = "/bin/sh";

export function commandArgv(command: string): string[] {
  const parsed = shellWords(command);
  const words = parsed?.[0] === "exec" ? parsed.slice(1) : parsed;
  if (words && words.length > 0 && !words[0].includes("=") && !SHELL_BUILTINS.has(words[0])) return words;
  return [REX_SHELL, "-c", command];
}

export const REX_LAUNCH_VERB = "__rex-launch";
export const REX_LAUNCH_SCRIPT = '"$0" "$1" "$2" "$3" "$$"; shift 4; unset OSC7577_TOKEN; exec "$@"';
export const hiveInvocation = (): string[] => [process.execPath, cliPath()];

export function rexLaunchArgv(agentId: number, argv: string[]): string[] {
  return [REX_SHELL, "-c", REX_LAUNCH_SCRIPT, ...hiveInvocation(), REX_LAUNCH_VERB, String(agentId), "--", ...argv];
}

export const REX_ENV_PROGRAM = "/usr/bin/env";
export const rexPanePath = (): string => paneEnvPath() ?? process.env.PATH ?? "";

export function rexBlockCommand(env: Record<string, string>, argv: string[]): string[] {
  const path = rexPanePath();
  return [REX_ENV_PROGRAM, ...(path ? [`PATH=${path}`] : []), ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...argv];
}

interface WindowHit {
  session: string;
  window: string;
}

function resolveOne(server: string, kind: "window" | "block", query: string, scope: string): (WindowHit & { block: string }) | null {
  const reply = rexApi<{ results?: { status?: string; target?: { session_id?: string; window_id?: string; block_id?: string } | null }[] | null }>(
    server,
    "target.resolve",
    { kinds: [kind], queries: [query], scope: { session: scope } },
  );
  const hit = reply.results?.[0];
  if (hit?.status !== "resolved" || !hit.target?.session_id) return null;
  return { session: hit.target.session_id, window: hit.target.window_id ?? "", block: hit.target.block_id ?? "" };
}

function recordedWindow(projectId: number): string | null {
  if (store === null) return null;
  const row = guarded(
    () => sql().prepare("SELECT value FROM kv WHERE project_id = ? AND key = ?").get(projectId, rexWindowKey(projectId)) as { value: string } | undefined,
    undefined,
  );
  return row?.value || null;
}

function writeKv(projectId: number, key: string, value: string): void {
  if (store === null) return;
  sql()
    .prepare(
      `INSERT INTO kv (project_id, key, value, updated_by) VALUES (?, ?, ?, 'hive')
       ON CONFLICT (project_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(projectId, key, value);
}

function leadBlockOf(projectId: number): string | null {
  if (store === null) return null;
  const row = guarded(
    () =>
      sql()
        .prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND kind = 'lead' AND status = 'running' AND tmux_target LIKE 'block:%' ORDER BY id DESC LIMIT 1")
        .get(projectId) as { tmux_target: string } | undefined,
    undefined,
  );
  return row?.tmux_target ?? null;
}

const callerBlock = rexCallerBlock;

function homeSession(server: string): string {
  const caller = callerBlock();
  if (caller) {
    try {
      return rexSessionOf(server, caller);
    } catch (err) {
      if (!blockGone(err)) throw err;
    }
  }
  const label = sessionName();
  const reply = rexApi<{ results?: { status?: string; target?: { session_id?: string } | null; candidates?: { kind?: string; session_id?: string }[] | null }[] | null }>(
    server,
    "target.resolve",
    { kinds: ["session"], queries: [label] },
  );
  const hit = reply.results?.[0];
  if (hit?.status === "resolved" && hit.target?.session_id) return hit.target.session_id;
  const candidate = hit?.status === "ambiguous" ? hit.candidates?.find((c) => c.kind === "session" && c.session_id)?.session_id : undefined;
  if (candidate) return candidate;
  return rexApi<{ session_id: string }>(server, "session.create", { label }).session_id;
}

function findWindow(server: string, window: string, likely: string[]): WindowHit | null {
  const look = (scope: string): WindowHit | null => {
    try {
      const hit = resolveOne(server, "window", window, scope);
      return hit ? { session: hit.session, window: hit.window || window } : null;
    } catch (err) {
      if (!blockGone(err)) throw err;
      return null;
    }
  };
  for (const scope of [...new Set(likely)]) {
    const hit = look(scope);
    if (hit) return hit;
  }
  const listed = rexApi<{ sessions?: { session_id?: string }[] | null }>(server, "session.list", {});
  for (const s of listed.sessions ?? []) {
    const hit = s.session_id ? look(s.session_id) : null;
    if (hit) return hit;
  }
  return null;
}

export function rexEnsureHome(projectId: number, _projectName: string): { session: string; window: string } {
  const server = requireServer("", null);
  const recorded = recordedWindow(projectId);
  if (recorded) {
    const scopes = [leadBlockOf(projectId), callerBlock(), sessionName()].filter((s): s is string => !!s);
    const found = findWindow(server, recorded, scopes);
    if (found) return found;
  }
  return { session: homeSession(server), window: "" };
}

function blockSize(server: string, session: string, block: string): { columns: number; rows: number } | undefined {
  const size = guarded(() => blockMethod<{ columns?: number; rows?: number }>(server, session, block, "size"), {});
  return size.columns && size.rows ? { columns: size.columns, rows: size.rows } : undefined;
}

interface CreatedReply {
  window_id?: string | null;
  block_ids?: (string | null)[] | null;
}

function blockOptions(spec: RexPaneSpec, size: { columns: number; rows: number } | undefined) {
  return {
    shell: "none",
    login: false,
    command: rexBlockCommand(spec.env, spec.agentId === undefined ? spec.argv : rexLaunchArgv(spec.agentId, spec.argv)),
    cwd: spec.cwd,
    exit: { on_completion: !spec.retainOnExit, quick_exit_threshold_ms: REX_QUICK_EXIT_MS },
    ...(size ? { size } : {}),
  };
}

export const REX_CLOSE_ATTEMPTS = 3;

function closeWithRetry(target: string, server: string): string | null {
  let detail = "";
  for (let attempt = 1; attempt <= REX_CLOSE_ATTEMPTS; attempt++) {
    try {
      rexClose(target, server);
      return null;
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }
    if (attempt < REX_CLOSE_ATTEMPTS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * attempt);
  }
  return detail;
}

export function rexRespawn(
  old: string,
  spec: RexPaneSpec,
  record: (placed: RexPlaced) => void = () => {},
  orphaned: (detail: string) => void = () => {},
): { target: string; pid: string } {
  const server = requireServer(old, null);
  const session = rexSessionOf(server, old);
  const size = spec.size ?? blockSize(server, session, old);
  const created = rexApi<{ block_id?: string | null }>(server, "session.new_block", {
    session_id: session, flavor: REX_SHELL_FLAVOR, label: spec.label, options: blockOptions(spec, size),
  });
  const target = created.block_id;
  if (!target) throw new RexError(`rex created no block for ${spec.label}`, "bad_output", "");
  let placed: RexPlaced;
  try {
    rexApi(server, "session.move_block", { session_id: session, block_id: target, anchor_block_id: old, side: "before" });
    const probe = rexProbe(target, server);
    if (probe.exited) quickExit(target, server);
    placed = { target, socket: rexSocketOf(server), pid: probe.pid ?? "", window: "" };
    record(placed);
  } catch (err) {
    bestEffort(() => rexClose(target, server));
    throw err;
  }
  const closeFailure = closeWithRetry(old, server);
  if (closeFailure !== null) bestEffort(() => orphaned(closeFailure));
  return { target, pid: placed.pid };
}

export function rexUnownedBlocks(server?: string | null): { block: string; label: string }[] | null {
  const snap = rexSnapshot(server);
  if (snap === null || !snap.answered || snap.incomplete) return null;
  const owned = new Set(ownedBlocks(rexSocketOf(snap.server)));
  const names = (sql().prepare("SELECT name FROM projects").all() as { name: string }[]).map((p) => `${p.name}/`);
  return [...snap.blocks]
    .filter(([id, b]) => !owned.has(id) && names.some((n) => b.label.startsWith(n)))
    .map(([block, b]) => ({ block, label: b.label }));
}

export function rexCreatePane(spec: RexPaneSpec): RexPlaced {
  if (store !== null && store.inTransaction === false) {
    throw new Error("rexCreatePane must run inside withWindowClaim, so two hive processes cannot create the same project's tab");
  }
  const server = requireServer(spec.beside ?? "", null);
  let session: string;
  let window = "";
  let anchor: WindowHit & { block: string } | null = null;
  if (spec.placement === "lead") {
    const home = rexEnsureHome(spec.projectId, spec.projectName);
    session = home.session;
    window = home.window;
  } else {
    if (!spec.beside) throw new RexError(`a ${spec.placement} block needs the lead block to sit beside`, "bad_request", "");
    anchor = resolveOne(server, "block", spec.beside, spec.beside);
    if (!anchor) throw new RexError(`the lead block ${spec.beside} is not open on ${server}`, "not_found", "");
    session = anchor.session;
  }
  const size = spec.size ?? (spec.beside ? blockSize(server, session, spec.beside) : undefined);
  const layout = { block: { flavor: REX_SHELL_FLAVOR, label: spec.label, options: blockOptions(spec, size) } };
  let reply: CreatedReply;
  if (spec.placement === "split" || spec.placement === "hidden") {
    reply = rexApi<CreatedReply>(server, "session.new_split", {
      session_id: session, anchor_id: spec.beside, direction: "horizontal", side: "after", layout, focus: false,
    });
    window = anchor!.window;
  } else if (spec.placement === "lead" && window) {
    reply = rexApi<CreatedReply>(server, "session.new_split", {
      session_id: session, window_id: window, direction: "horizontal", side: "before", layout, focus: false,
    });
  } else {
    reply = rexApi<CreatedReply>(server, "session.new_window", {
      session_id: session, window_label: spec.placement === "lead" ? spec.projectName : spec.label, layout, focus: false,
    });
    window = reply.window_id ?? "";
    if (spec.placement === "lead" && window) writeKv(spec.projectId, rexWindowKey(spec.projectId), window);
  }
  const target = reply.block_ids?.[0];
  if (!target) throw new RexError(`rex created no block for ${spec.label}`, "bad_output", "");
  writeKv(spec.projectId, REX_IN_USE_KEY, "1");
  const probe = rexProbe(target, server);
  if (probe.exited) quickExit(target, server);
  if (spec.placement === "hidden") {
    try {
      rexFloatHidden(target, spec.beside!, server);
    } catch (err) {
      bestEffort(() => rexClose(target, server));
      throw err;
    }
  }
  return { target, socket: rexSocketOf(server), pid: probe.pid ?? "", window };
}

export class RexQuickExit extends Error {
  constructor(readonly target: string, readonly screen: string) {
    super(
      `The command exited immediately, so its block ${target} was closed rather than recorded as running. ` +
        `Check the command and its arguments, then retry.${screen ? ` Its screen:\n${screen}` : ""}`,
    );
    this.name = "RexQuickExit";
  }
}

function quickExit(target: string, server?: string): never {
  const screen = guarded(() => rexCapture(target, 200, false, server).trim(), "");
  rexClose(target, server);
  throw new RexQuickExit(target, screen);
}

export function rexRefuseQuickExit(target: string, server?: string, windowMs = REX_QUICK_EXIT_MS): void {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const probe = rexProbe(target, server);
    if (probe.exited) quickExit(target, server);
    if (probe.live === false) throw new RexQuickExit(target, "");
    if (Date.now() >= deadline) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

type Rect = [number, number, number, number];

interface ViewNode {
  rect?: number[] | null;
  block_id?: string | null;
  split?: { before?: ViewNode | null; after?: ViewNode | null } | null;
}

interface ViewLayer {
  layer_id?: string | null;
  kind?: string;
  state?: string;
  layout?: ViewNode | null;
  blocks?: { block_id?: string | null }[] | null;
}

interface SessionView {
  windows?: { window_id?: string | null; layers?: ViewLayer[] | null }[] | null;
}

interface BlockPlace {
  window: string;
  layer: string;
  floating: boolean;
  minimized: boolean;
  rect: Rect | null;
}

const WHOLE_WINDOW: Rect = [0, 0, 1, 1];

function rectIn(node: ViewNode | null | undefined, block: string): Rect | null {
  if (!node) return null;
  if (node.block_id === block) return Array.isArray(node.rect) && node.rect.length === 4 ? (node.rect as Rect) : null;
  return rectIn(node.split?.before, block) ?? rectIn(node.split?.after, block);
}

function placeOf(view: SessionView, block: string): BlockPlace | null {
  for (const window of view.windows ?? []) {
    for (const layer of window.layers ?? []) {
      if (!(layer.blocks ?? []).some((b) => b.block_id === block)) continue;
      return {
        window: window.window_id ?? "",
        layer: layer.layer_id ?? "",
        floating: layer.kind !== "tiled",
        minimized: layer.state === "minimized",
        rect: rectIn(layer.layout, block),
      };
    }
  }
  return null;
}

const fits = (rect: Rect | null): Rect => {
  if (!rect || rect.some((n) => !Number.isFinite(n)) || rect[2] <= 0 || rect[3] <= 0) return WHOLE_WINDOW;
  const x = Math.min(Math.max(rect[0], 0), 1);
  const y = Math.min(Math.max(rect[1], 0), 1);
  const w = Math.min(rect[2], 1 - x);
  const h = Math.min(rect[3], 1 - y);
  return w > 0 && h > 0 ? [x, y, w, h] : WHOLE_WINDOW;
};

const sessionView = (server: string, session: string): SessionView => rexApi<SessionView>(server, "session.view", { session_id: session });

function placed(view: SessionView, block: string): BlockPlace {
  const where = placeOf(view, block);
  if (!where) throw new RexError(`block ${block} is not in a tab of the lead's session`, "not_found", "");
  return where;
}

export function rexFloatHidden(target: string, leadTarget: string, server?: string): void {
  const resolved = requireServer(leadTarget, server);
  const session = rexSessionOf(resolved, leadTarget);
  let view = sessionView(resolved, session);
  const lead = placed(view, leadTarget);
  let mine = placed(view, target);
  if (mine.window !== lead.window) {
    rexApi(resolved, "session.move_block", { session_id: session, block_id: target, anchor_block_id: leadTarget, side: "after" });
    view = sessionView(resolved, session);
    mine = placed(view, target);
  }
  let layer = mine.layer;
  if (!mine.floating) {
    layer = rexApi<{ layer_id?: string | null }>(resolved, "session.float_block", {
      session_id: session, block_id: target, bounds: fits(placed(view, leadTarget).rect),
    }).layer_id ?? "";
    if (!layer) throw new RexError(`rex floated ${target} but named no layer`, "bad_output", "");
  }
  if (!mine.floating || !mine.minimized) {
    rexApi(resolved, "session.set_layer_state", { session_id: session, layer_id: layer, state: "minimized" });
  }
  const sized = fits(placed(sessionView(resolved, session), leadTarget).rect);
  rexApi(resolved, "session.resize_layer", { session_id: session, layer_id: layer, bounds: sized });
}

export const REX_PLACEHOLDER_ARGV = ["/bin/sleep", "600"];

export function rexUnfloat(target: string, leadTarget: string, placement: "split" | "window", windowLabel?: string, server?: string): void {
  const resolved = requireServer(leadTarget, server);
  const session = rexSessionOf(resolved, leadTarget);
  placed(sessionView(resolved, session), target);
  if (placement === "split") {
    rexApi(resolved, "session.move_block", { session_id: session, block_id: target, anchor_block_id: leadTarget, direction: "horizontal", side: "after" });
    return;
  }
  const made = rexApi<CreatedReply>(resolved, "session.new_window", {
    session_id: session,
    ...(windowLabel ? { window_label: windowLabel } : {}),
    layout: {
      block: {
        flavor: REX_SHELL_FLAVOR,
        label: "hive placeholder",
        options: { shell: "none", login: false, command: REX_PLACEHOLDER_ARGV, exit: { on_completion: true } },
      },
    },
    focus: false,
  });
  const placeholder = made.block_ids?.[0];
  if (!placeholder) throw new RexError("rex created no placeholder block for the new tab", "bad_output", "");
  try {
    rexApi(resolved, "session.move_block", { session_id: session, block_id: target, anchor_block_id: placeholder, side: "after" });
  } finally {
    rexClose(placeholder, resolved);
  }
}

export type RexVisibility = "shown" | "hidden" | "window";

function visibilityIn(view: SessionView, target: string, leadTarget: string | null): RexVisibility | null {
  const mine = placeOf(view, target);
  if (!mine) return null;
  if (mine.floating) return "hidden";
  const lead = leadTarget ? placeOf(view, leadTarget) : null;
  return lead && lead.window !== mine.window ? "window" : "shown";
}

export function rexVisibility(target: string, leadTarget: string | null, server?: string): RexVisibility | null {
  try {
    const resolved = requireServer(target, server);
    return visibilityIn(sessionView(resolved, rexSessionOf(resolved, target)), target, leadTarget);
  } catch {
    return null;
  }
}

export interface RexPort {
  port: number;
  address: string;
}

interface PortsReply {
  id?: number;
  status?: string;
  truncated?: boolean;
  ports?: { port?: unknown; address?: unknown; protocol?: unknown }[];
}

function readPortsReply(server: string, session: string, block: string): PortsReply {
  const head = blockMethod<PortsReply>(server, session, block, "ports");
  if (head.truncated !== true || head.id === undefined) return head;
  return guarded(() => JSON.parse(readForward(server, session, block, head.id as number, 0)) as PortsReply, head);
}

function tcpListeners(reply: PortsReply): RexPort[] | "unsupported" | null {
  if (reply.status === "unsupported") return "unsupported";
  if (!Array.isArray(reply.ports)) return null;
  return reply.ports
    .filter((p) => p.protocol === "tcp" && Number.isInteger(p.port) && typeof p.address === "string")
    .map((p) => ({ port: p.port as number, address: p.address as string }));
}

const readPorts = (server: string, session: string, target: string): RexPort[] | "unsupported" | null =>
  guarded(() => tcpListeners(readPortsReply(server, session, target)), null);

const portsIn = (server: string, session: string, target: string): RexPort[] | null => {
  const read = readPorts(server, session, target);
  return read === "unsupported" ? null : read;
};

export function rexPorts(target: string, server?: string): RexPort[] | null {
  if (!target.startsWith("block:")) return null;
  try {
    const resolved = requireServer(target, server);
    return portsIn(resolved, rexSessionOf(resolved, target), target);
  } catch {
    return null;
  }
}

export function rexVisibilityAndPorts(target: string, server?: string): { visibility: RexVisibility | null; ports: RexPort[] | null } {
  try {
    const resolved = requireServer(target, server);
    const session = rexSessionOf(resolved, target);
    const view = sessionView(resolved, session);
    return { visibility: visibilityIn(view, target, null), ports: portsIn(resolved, session, target) };
  } catch {
    return { visibility: null, ports: null };
  }
}

export const REX_PORT_POLL_MS = 250;
const REX_PORT_PROBE_EVERY = 4;

export type RexPortWait = { ports: RexPort[] } | { stopped: "exited" | "unsupported" | "timeout" };

const portWanted = (ports: RexPort[], want: number | true): boolean => (want === true ? ports.length > 0 : ports.some((p) => p.port === want));

export function rexAwaitPorts(target: string, want: number | true, timeoutMs = 60_000, server?: string): RexPortWait {
  const deadline = Date.now() + timeoutMs;
  let session: string | null = null;
  for (let miss = 0; ; miss++) {
    const resolved = guarded(() => requireServer(target, server), null);
    if (resolved && session === null) session = guarded(() => rexSessionOf(resolved, target), null);
    const read = resolved && session ? readPorts(resolved, session, target) : null;
    if (read === "unsupported") return { stopped: "unsupported" };
    if (read && portWanted(read, want)) return { ports: read };
    if (read === null) session = null;
    if (miss % REX_PORT_PROBE_EVERY === 0 && miss > 0) {
      const probe = rexProbe(target, server);
      if (probe.exited || probe.live === false) return { stopped: "exited" };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { stopped: "timeout" };
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(REX_PORT_POLL_MS, remaining));
  }
}

export const waitForPort = (target: string, want: number | true, timeoutMs = 60_000, server?: string): boolean =>
  "ports" in rexAwaitPorts(target, want, timeoutMs, server);

type Direction = "horizontal" | "vertical";

export interface RexLayoutPlan {
  moves: { block: string; anchor: string; direction: Direction }[];
  resizes: { before: string; after: string; direction: Direction; ratio: number }[];
}

function chain(panes: string[], direction: Direction, plan: RexLayoutPlan): void {
  for (let i = 1; i < panes.length; i++) plan.moves.push({ block: panes[i], anchor: panes[i - 1], direction });
  for (let i = 0; i + 1 < panes.length; i++) {
    plan.resizes.push({ before: panes[i], after: panes[i + 1], direction, ratio: 1 / (panes.length - i) });
  }
}

export function rexLayoutPlan(lead: string, blocks: string[], layout: WindowLayout): RexLayoutPlan {
  const plan: RexLayoutPlan = { moves: [], resizes: [] };
  const panes = [lead, ...blocks];
  if (blocks.length === 0) return plan;
  if (layout === "even-horizontal" || layout === "even-vertical") {
    chain(panes, layout === "even-horizontal" ? "horizontal" : "vertical", plan);
  } else if (layout === "main-vertical" || layout === "main-horizontal") {
    const main: Direction = layout === "main-vertical" ? "horizontal" : "vertical";
    plan.moves.push({ block: blocks[0], anchor: lead, direction: main });
    plan.resizes.push({ before: lead, after: blocks[0], direction: main, ratio: 0.5 });
    chain(blocks, main === "horizontal" ? "vertical" : "horizontal", plan);
  } else {
    const columns = Math.ceil(Math.sqrt(panes.length));
    const rows: string[][] = [];
    for (let i = 0; i < panes.length; i += columns) rows.push(panes.slice(i, i + columns));
    const heads = rows.map((row) => row[0]);
    const columnPlan: RexLayoutPlan = { moves: [], resizes: [] };
    chain(heads, "vertical", columnPlan);
    plan.moves.push(...columnPlan.moves);
    for (const row of rows) chain(row, "horizontal", plan);
    plan.resizes.unshift(...columnPlan.resizes);
  }
  return plan;
}

export function rexApplyLayout(window: { lead: string; blocks: string[]; server?: string }, layout: WindowLayout): RexLayoutPlan {
  const resolved = requireServer(window.lead, window.server);
  const session = rexSessionOf(resolved, window.lead);
  const plan = rexLayoutPlan(window.lead, window.blocks, layout);
  for (const move of plan.moves) {
    rexApi(resolved, "session.move_block", {
      session_id: session, block_id: move.block, anchor_block_id: move.anchor, direction: move.direction, side: "after",
    });
  }
  for (const resize of plan.resizes) {
    rexApi(resolved, "session.resize_pane", {
      session_id: session, direction: resize.direction, before_block_id: resize.before, after_block_id: resize.after, ratio: resize.ratio,
    });
  }
  return plan;
}

interface ProjectBlockRow {
  name: string;
  kind: string;
  tmux_target: string;
  tmux_socket: string;
  pane_pid: string;
  command: string;
}

function runningLeadBlock(projectId: number): ProjectBlockRow | null {
  return (
    (sql()
      .prepare(
        `SELECT name, kind, tmux_target, tmux_socket, pane_pid, command FROM agents
          WHERE project_id = ? AND kind = 'lead' AND status = 'running' AND tmux_target LIKE 'block:%' ORDER BY id DESC LIMIT 1`,
      )
      .get(projectId) as ProjectBlockRow | undefined) ?? null
  );
}

export function rexLayoutProject(projectId: number, layout: WindowLayout): { lines: string[]; exitCode: number } {
  const lead = runningLeadBlock(projectId);
  if (!lead || rexOwnership(lead) !== "live") return { lines: ["the lead block could not be verified; nothing was changed"], exitCode: 1 };
  const server = rowServer(lead.tmux_socket, lead.tmux_target);
  if (!server) return { lines: ["Rex could not be reached; nothing was changed"], exitCode: 1 };
  const rows = sql()
    .prepare(
      `SELECT name, kind, tmux_target, tmux_socket, pane_pid, command FROM agents
        WHERE project_id = ? AND kind != 'lead' AND status = 'running' AND tmux_target LIKE 'block:%' AND tmux_socket = ? ORDER BY id`,
    )
    .all(projectId, lead.tmux_socket) as ProjectBlockRow[];
  const snap = rexSnapshot(server, rows.map((r) => r.tmux_target));
  if (snap === null || !snap.answered) return { lines: ["Rex could not be reached; nothing was changed"], exitCode: 1 };
  const view = sessionView(server, rexSessionOf(server, lead.tmux_target));
  const visible = rows.filter((r) => rexOwnership(r, snap) === "live" && placeOf(view, r.tmux_target)?.floating === false);
  if (visible.length === 0) return { lines: ["nothing to arrange"], exitCode: 0 };
  rexApplyLayout({ lead: lead.tmux_target, blocks: visible.map((r) => r.tmux_target), server }, layout);
  return {
    lines: [`arranged the lead and ${visible.length} block${visible.length === 1 ? "" : "s"} (${visible.map((r) => r.name).join(", ")}); layout ${layout}`],
    exitCode: 0,
  };
}

export const rexProjectLead = (projectId: number): { tmux_target: string; tmux_socket: string; pane_pid: string; command: string } | null =>
  store === null ? null : guarded(() => runningLeadBlock(projectId), null);

export const rexCannotTell = (name: string): string => `${name}: Rex could not be probed, so hive cannot tell where its block is`;

interface RexSpot {
  floating: boolean;
  minimized: boolean;
  ownTab: boolean;
  layer: string;
  session: string;
  server: string;
}

function rexSpot(target: string, leadTarget: string, server?: string): RexSpot | null {
  try {
    const resolved = requireServer(target, server);
    const session = rexSessionOf(resolved, target);
    const view = sessionView(resolved, session);
    const mine = placeOf(view, target);
    if (!mine) return null;
    const lead = placeOf(view, leadTarget);
    return {
      floating: mine.floating, minimized: mine.floating && mine.minimized, ownTab: !lead || lead.window !== mine.window,
      layer: mine.layer, session, server: resolved,
    };
  } catch {
    return null;
  }
}

export type RexShownAs = "split" | "window";
export const rexShownAsKey = (target: string): string => `terminal:rex:shown-as:${target}`;

export function rexRememberShownAs(projectId: number, target: string, placement: RexShownAs): void {
  writeKv(projectId, rexShownAsKey(target), placement);
}

export function rexForgetShownAs(projectId: number, target: string): void {
  if (store === null) return;
  guarded(() => void sql().prepare("DELETE FROM kv WHERE project_id = ? AND key = ?").run(projectId, rexShownAsKey(target)), undefined);
}

export function rexShownAs(projectId: number, target: string): RexShownAs | null {
  if (store === null) return null;
  const row = guarded(
    () => sql().prepare("SELECT value FROM kv WHERE project_id = ? AND key = ?").get(projectId, rexShownAsKey(target)) as { value: string } | undefined,
    undefined,
  );
  return row?.value === "split" || row?.value === "window" ? row.value : null;
}

const leadServer = (lead: ProjectBlockRow): string | undefined => rowServer(lead.tmux_socket, lead.tmux_target) ?? undefined;

export function rexHideBlock(projectId: number, name: string, target: string, remember = false): string {
  const lead = runningLeadBlock(projectId);
  if (!lead) return `${name}: this project has no lead block to float it beside; run hive first`;
  const spot = rexSpot(target, lead.tmux_target, leadServer(lead));
  if (spot === null) return rexCannotTell(name);
  if (spot.minimized) return `${name}: already hidden`;
  if (remember && !spot.floating) rexRememberShownAs(projectId, target, spot.ownTab ? "window" : "split");
  rexFloatHidden(target, lead.tmux_target, leadServer(lead));
  return `${name}: hidden`;
}

export function rexShowBlock(projectId: number, name: string, target: string, placement: RexShownAs, windowLabel: string): string {
  const lead = runningLeadBlock(projectId);
  if (!lead) return `${name}: this project has no lead block to show it beside; run hive first`;
  const where = rexVisibility(target, lead.tmux_target, leadServer(lead));
  if (where === null) return rexCannotTell(name);
  if (where !== "hidden") return `${name}: already shown`;
  rexUnfloat(target, lead.tmux_target, placement, windowLabel, leadServer(lead));
  return `${name}: shown`;
}

export interface RexFocus {
  focused: boolean;
  selected: boolean;
  hint: string;
}

interface LabelledView {
  label?: string | null;
  windows?: { window_id?: string | null; label?: string | null; layers?: ViewLayer[] | null }[] | null;
}

interface ClientList {
  clients?: { client_id?: string; connection_state?: string }[] | null;
}

export const REX_SELECT_TIMEOUT_MS = 5000;

function selectSession(server: string, session: string, window: string): boolean {
  let clients: string[];
  try {
    const listed = rexApi<ClientList>(server, "client.list", { kinds: ["app"] }).clients ?? [];
    clients = listed.filter((c) => c.client_id && c.connection_state !== "lost").map((c) => c.client_id as string);
  } catch {
    return false;
  }
  let selected = false;
  for (const client_id of clients) {
    try {
      const args = window ? { session_id: session, window_id: window } : { session_id: session };
      rexApi(server, "client.perform", { client_id, action: "session.select", args, origin: "cli", timeout_ms: REX_SELECT_TIMEOUT_MS });
      selected = true;
    } catch {}
  }
  return selected;
}

export function rexFocus(target: string, server?: string): RexFocus {
  const resolved = requireServer(target, server);
  const session = rexSessionOf(resolved, target);
  let focused = true;
  try {
    rexApi(resolved, "session.focus_block", { session_id: session, block_id: target });
  } catch (err) {
    if (!blockGone(err)) throw err;
    focused = false;
  }
  let window = "";
  let hint = `Rex session ${session}, tab (unknown)`;
  try {
    const view = rexApi<LabelledView>(resolved, "session.view", { session_id: session });
    window = placeOf(view as SessionView, target)?.window ?? "";
    const tab = (view.windows ?? []).find((w) => w.window_id === window)?.label ?? "";
    hint = `Rex session ${view.label || session}, tab ${tab || window || "(unknown)"}`;
  } catch {}
  return { focused, selected: focused && selectSession(resolved, session, window), hint };
}

export function rexPeekBlock(projectId: number, name: string, target: string): string {
  const lead = runningLeadBlock(projectId);
  if (!lead) return `${name}: this project has no lead block to peek over; run hive first`;
  const spot = rexSpot(target, lead.tmux_target, leadServer(lead));
  if (spot === null) return rexCannotTell(name);
  if (!spot.floating) return `${name}: not hidden, so there is nothing to peek at`;
  rexApi(spot.server, "session.set_layer_state", { session_id: spot.session, layer_id: spot.layer, state: "normal", focus: true });
  return `${name}: peeking over the lead; hive hide ${name} minimizes it again`;
}
