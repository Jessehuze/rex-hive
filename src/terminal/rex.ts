import { basename } from "node:path";
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
} from "../tmux.js";

export const rexRefusal = (operation: string): string =>
  `${operation} is not available under the Rex terminal in this build; restart the lead with HIVE_TERMINAL=tmux to use it`;

export class RexNotImplemented extends Error {
  constructor(readonly operation: string) {
    super(rexRefusal(operation));
    this.name = "RexNotImplemented";
  }
}

const refuse = (operation: string): never => {
  throw new RexNotImplemented(operation);
};

export const startProcess = (): never => refuse("hive.yml processes");
export const floatHidden = (): never => refuse("hidden workers");

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

export interface ProgramStatus {
  state: string;
  kind: string | null;
  msg: string | null;
}

export interface RexBlock {
  pid: string;
  argv: string;
  programs: string[];
  exited: boolean;
  status: ProgramStatus | null;
  subagents: number;
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

function readStatus(reply: { records?: StatusRecord[] | Record<string, never> } | null | undefined) {
  const records = Array.isArray(reply?.records) ? reply.records : [];
  const root = records.find((r) => r.id === undefined || r.id === "") ?? null;
  return {
    status: root ? { state: root.state ?? "idle", kind: root.kind ?? null, msg: root.msg ?? null } : null,
    subagents: records.filter((r) => r.id !== undefined && r.id !== "").length,
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
  const incomplete = reply.incomplete === true || missingBlocksStillOpen(resolved, wanted.filter((id) => !blocks.has(id)));
  return { answered: true, server: resolved, incomplete, unreachableSince: null, blocks };
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
  if (heads.length > 0 && programs.length > 0 && !heads.some((h) => programs.includes(h))) return "reissued";
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

export function rexStop(target: string, timeoutMs: number, server?: string): void {
  const resolved = requireServer(target, server);
  try {
    rexSendKey(target, "C-c", resolved);
  } catch (err) {
    if (blockGone(err)) return;
    throw err;
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = rexProbe(target, resolved);
    if (probe.live === false || probe.exited || Date.now() >= deadline) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  rexClose(target, resolved);
}

export const REX_SHELL_FLAVOR = "com.superlogical.terminal.shell";
export const REX_IN_USE_KEY = "terminal:rex:in-use";
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
    command: rexBlockCommand(spec.env, spec.argv),
    cwd: spec.cwd,
    exit: { on_completion: !spec.retainOnExit, quick_exit_threshold_ms: REX_QUICK_EXIT_MS },
    ...(size ? { size } : {}),
  };
}

export function rexRespawn(old: string, spec: RexPaneSpec, record: (placed: RexPlaced) => void = () => {}): { target: string; pid: string } {
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
  bestEffort(() => rexClose(old, server));
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
  if (spec.placement === "hidden") floatHidden();
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
  if (spec.placement === "split") {
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
