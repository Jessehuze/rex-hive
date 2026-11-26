import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY = join(HERE, "relay.mjs");
const TERMINAL = "com.superlogical.terminal";
const SNAPSHOT_HEADER = "-- hive:snapshot v1";
const FAKE_HOME = "/home/fake-user";

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new ApiError(code, message);
};

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const STATE = process.env.FAKE_REX_STATE;
if (!STATE) {
  process.stderr.write("fake rex: FAKE_REX_STATE is unset; isolateRex sets it\n");
  process.exit(2);
}
const DIR = dirname(STATE);
const CALLS = join(DIR, "fake-rex-calls.jsonl");
const LOCK = `${STATE}.lock`;

function readState() {
  return JSON.parse(readFileSync(STATE, "utf8"));
}

function writeState(state) {
  const tmp = `${STATE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, STATE);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function lockAbandoned() {
  try {
    const holder = Number(readFileSync(LOCK, "utf8"));
    if (holder > 0) return !pidAlive(holder);
    return Date.now() - statSync(LOCK).mtimeMs > 5000;
  } catch {
    return false;
  }
}

function withLock(fn) {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const fd = openSync(LOCK, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (lockAbandoned()) rmSync(LOCK, { force: true });
      if (Date.now() > deadline) throw new Error("fake rex: state lock timed out");
      sleepMs(5);
    }
  }
  try {
    const state = readState();
    const result = fn(state);
    writeState(state);
    return result;
  } finally {
    rmSync(LOCK, { force: true });
  }
}

function parseArgs(argv) {
  const global = { autostart: null, timeout: null, server: null, client: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const inline = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : null;
    const take = () => inline ?? argv[++i];
    if (name === "--autostart") global.autostart = inline ?? "true";
    else if (name === "--timeout") global.timeout = take();
    else if (name === "-S" || name === "--server") global.server = take();
    else if (name === "-C" || name === "--client") global.client = take();
    else if (name === "--color") take();
    else rest.push(a);
  }
  return { global, rest };
}

function flags(rest, spec) {
  const out = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const key = spec[a];
    if (key === undefined) out._.push(a);
    else if (key.endsWith("?")) out[key.slice(0, -1)] = true;
    else out[key] = rest[++i];
  }
  return out;
}

const nextRevision = (state) => (state.revision = (state.revision ?? 0) + 1);
const sessionById = (state, id) => state.sessions.find((s) => s.session_id === id);
const windowById = (state, id) => state.windows.find((w) => w.window_id === id);

function requireSession(state, id) {
  const session = sessionById(state, id);
  if (!session) fail("session_not_found", `session ${id} does not exist`);
  return session;
}

function requireBlock(state, params) {
  requireSession(state, params.session_id);
  const block = state.blocks[params.block_id];
  if (!block || block.session_id !== params.session_id) fail("not_found", `block ${params.block_id} is not in the session`);
  return block;
}

const FRESH_ENV_KEYS = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "NODE_TEST_CONTEXT", "FAKE_REX_STATE", "FAKE_REX_OWNER"];

function freshEnv(extra) {
  const env = { PATH: MINIMAL_PATH, SHELL: "/bin/sh" };
  for (const k of FRESH_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

function childEnv(state, block) {
  let env = {};
  if (block.fresh_env) env = { ...block.fresh_env };
  else {
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith("REX_") || k.startsWith("HIVE_") || k === "OSC7577_TOKEN" || (k.startsWith("FAKE_REX_") && k !== "FAKE_REX_STATE" && k !== "FAKE_REX_OWNER")) continue;
      env[k] = v;
    }
    if (!loginWrapped(block)) env.PATH = MINIMAL_PATH;
  }
  env.REX_SERVER = state.address;
  env.REX_BLOCK = block.block_id;
  env.REX_SESSION = block.session_id;
  env.OSC7577_TOKEN = block.token;
  return env;
}

const RESUME_REPORT = /\x1b\]7577;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const RESUME_TIME_WINDOW_S = 60;

function resumeRecord(block) {
  const file = join(block.dir, "output");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  let record = null;
  for (const [, body] of text.matchAll(RESUME_REPORT)) {
    const cut = body.lastIndexOf(":mac=");
    if (cut < 0 || !block.token) continue;
    const head = body.slice(0, cut);
    if (createHash("sha256").update(`${head}:${block.token}`).digest("hex") !== body.slice(cut + 5)) continue;
    const pairs = Object.fromEntries(head.split(":").map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
    if (Math.abs(Date.now() / 1000 - Number(pairs.time)) > RESUME_TIME_WINDOW_S || Number(pairs.pid) !== block.child_pid) continue;
    record = pairs.clear === "1" ? null : { argv: pairs.argv.split(",").map((a) => Buffer.from(a, "base64").toString("utf8")) };
  }
  return record;
}

const newToken = () => randomBytes(24).toString("base64url");

const BLOCK_OPTION_KEYS = new Set(["args", "command", "cwd", "exit", "initial_input", "interactive", "login", "path_prepend", "shell", "size", "theme"]);
const EXIT_OPTION_KEYS = new Set(["on_completion", "quick_exit_threshold_ms"]);
const MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const loginWrapped = (block) => block.options?.login !== false;

function checkOptions(options) {
  if (options === undefined) return;
  for (const key of Object.keys(options)) if (!BLOCK_OPTION_KEYS.has(key)) fail("bad_request", `unknown block option ${key}`);
  if (options.shell === "none" && !Array.isArray(options.command)) fail("bad_request", "shell none needs command as an argv array");
  if (options.exit !== undefined && (typeof options.exit !== "object" || Object.keys(options.exit).some((k) => !EXIT_OPTION_KEYS.has(k)))) fail("bad_request", "exit is {on_completion, quick_exit_threshold_ms}");
}

const ENV_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

const SH_SIMPLE = /^[^;&|<>()$`*?\n'"\\]*$/;

function execedProgram(command) {
  let i = 0;
  if (basename(command[0]) === "env") {
    i = 1;
    while (i < command.length && ENV_WORD.test(command[i])) i++;
  }
  const program = command[i] ?? command[0];
  const script = command[i + 2];
  const rest = command.indexOf("--", i + 3);
  if (basename(program) === "sh" && command[i + 1] === "-c" && typeof script === "string" && script.endsWith('exec "$@"') && rest > 0) {
    return execedProgram(command.slice(rest + 1));
  }
  if (basename(program) === "sh" && command[i + 1] === "-c" && typeof script === "string" && SH_SIMPLE.test(script)) {
    const words = script.trim().split(/\s+/).filter((w) => !ENV_WORD.test(w));
    if (words[0] && words[0] !== "exec") return words[0];
    if (words[1]) return words[1];
  }
  const tail = basename(program) === "sh" && command[i + 1] === "-c" && typeof script === "string" ? script.split("&&").at(-1).trim().match(/^exec\s+'?([^\s']+)/) : null;
  return tail ? tail[1] : program;
}

function reapCompleted(state) {
  for (const block of Object.values(state.blocks)) {
    const exit = processInfo(block).last_exit;
    if (!exit || block.options?.exit?.on_completion === false) continue;
    const threshold = block.options?.exit?.quick_exit_threshold_ms ?? 250;
    const raw = exitOf(block);
    const failed = (exit.exit_code ?? 0) !== 0;
    if (failed && (raw?.at ?? 0) - (block.started_at ?? 0) < threshold) continue;
    closeBlock(state, block);
  }
}

function commandOf(options) {
  const command = options?.command;
  if (Array.isArray(command) && command.length > 0) return command.map(String);
  if (typeof command === "string" && command) return ["/bin/sh", "-c", command];
  return ["/bin/sh"];
}

function startProcess(state, block) {
  rmSync(block.dir, { recursive: true, force: true });
  mkdirSync(block.dir, { recursive: true });
  writeFileSync(join(block.dir, "input"), "");
  writeFileSync(join(block.dir, "output"), "");
  const owner = process.env.FAKE_REX_OWNER ?? "0";
  block.started_at = Date.now();
  block.token = newToken();
  const relay = spawn(process.execPath, [RELAY, block.dir, block.cwd, STATE, owner, ...block.command], {
    detached: true,
    stdio: "ignore",
    env: childEnv(state, block),
  });
  relay.unref();
  block.relay_pid = relay.pid;
  const pidFile = join(block.dir, "child.pid");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const text = existsSync(pidFile) ? readFileSync(pidFile, "utf8") : "";
    if (text) {
      block.child_pid = Number(text);
      break;
    }
    if (existsSync(join(block.dir, "exit.json"))) break;
    sleepMs(10);
  }
  state.relays.push({ relay_pid: block.relay_pid, child_pid: block.child_pid, block_id: block.block_id });
}

function forgetRelay(state, block) {
  state.relays = state.relays.filter((r) => r.relay_pid !== block.relay_pid);
}

function killProcess(block) {
  for (const pid of [block.relay_pid && -block.relay_pid, block.child_pid]) {
    if (!pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

function createBlock(state, sessionId, spec) {
  checkOptions(spec.options);
  const id = `block:${randomUUID()}`;
  const block = {
    block_id: id,
    session_id: sessionId,
    window_id: null,
    layer_id: null,
    label: spec.label ?? "",
    flavor: spec.flavor ?? `${TERMINAL}.shell`,
    options: spec.options ?? {},
    command: commandOf(spec.options),
    cwd: spec.options?.cwd ?? DIR,
    dir: join(DIR, "fake-rex-blocks", id.slice(6)),
    relay_pid: null,
    child_pid: null,
    events: [],
    screen: null,
    title: null,
    program_status: [],
    ports: [],
    size: spec.options?.size ?? { columns: 80, rows: 24 },
  };
  state.blocks[id] = block;
  startProcess(state, block);
  return block;
}

function leaves(node) {
  if (!node) return [];
  if (node.block) return [node.block];
  if (node.split) return [...leaves(node.split.before), ...leaves(node.split.after)];
  fail("bad_request", "layout node is neither block nor split");
}

const leafIds = (node) => (!node ? [] : node.block_id ? [node.block_id] : [...leafIds(node.split.before), ...leafIds(node.split.after)]);

function syncLayer(state, window, layer) {
  layer.blocks = leafIds(layer.tree);
  for (const id of layer.blocks) {
    state.blocks[id].window_id = window.window_id;
    state.blocks[id].layer_id = layer.layer_id;
  }
  if (!window.focused_block_id && layer.blocks[0]) window.focused_block_id = layer.blocks[0];
}

const newSplit = (direction, ratio, before, after) => ({ split: { split_id: `split:${randomUUID()}`, direction, ratio: ratio ?? 0.5, before, after } });

function buildTree(state, sessionId, node) {
  if (!node) fail("bad_request", "layout is required");
  if (node.block) return { block_id: createBlock(state, sessionId, node.block).block_id };
  if (node.split) {
    if (!["horizontal", "vertical"].includes(node.split.direction)) fail("bad_request", "direction is horizontal or vertical");
    return newSplit(node.split.direction, node.split.ratio, buildTree(state, sessionId, node.split.before), buildTree(state, sessionId, node.split.after));
  }
  fail("bad_request", "layout node is neither block nor split");
}

function replaceNode(node, id, make) {
  if (!node) return null;
  if (node.block_id === id || node.split?.split_id === id) return make(node);
  if (!node.split) return null;
  for (const side of ["before", "after"]) {
    const hit = replaceNode(node.split[side], id, make);
    if (hit) {
      node.split[side] = hit;
      return node;
    }
  }
  return null;
}

function insertBeside(layer, anchorId, inserted, direction, side, ratio) {
  const make = (anchor) => (side === "before" ? newSplit(direction, ratio, inserted, anchor) : newSplit(direction, ratio, anchor, inserted));
  const tree = replaceNode(layer.tree, anchorId, make);
  if (!tree) fail("not_found", `anchor ${anchorId} is not in the layer`);
  layer.tree = tree;
}

function removeLeaf(node, id) {
  if (!node) return null;
  if (node.block_id) return node.block_id === id ? null : node;
  const before = removeLeaf(node.split.before, id);
  const after = removeLeaf(node.split.after, id);
  if (!before) return after;
  if (!after) return before;
  node.split.before = before;
  node.split.after = after;
  return node;
}

const tiledLayer = () => ({ layer_id: `layer:${randomUUID()}`, kind: "tiled", state: "normal", bounds: [0, 0, 1, 1], blocks: [], tree: null });

function createWindow(state, session, label, layout) {
  const window = {
    window_id: `window:${randomUUID()}`,
    session_id: session.session_id,
    label: label ?? "",
    focused_block_id: null,
    layers: [tiledLayer()],
  };
  state.windows.push(window);
  window.layers[0].tree = buildTree(state, session.session_id, layout);
  syncLayer(state, window, window.layers[0]);
  const blocks = window.layers[0].blocks.map((id) => state.blocks[id]);
  if (!session.active_window_id) session.active_window_id = window.window_id;
  return { window, blocks };
}

function removeFromWindow(state, block, { closeEmpty = true } = {}) {
  const window = windowById(state, block.window_id);
  block.window_id = null;
  block.layer_id = null;
  if (!window) return;
  for (const layer of window.layers) {
    layer.tree = removeLeaf(layer.tree, block.block_id);
    layer.blocks = leafIds(layer.tree);
  }
  window.layers = window.layers.filter((l) => l.kind === "tiled" || l.blocks.length > 0);
  if (window.focused_block_id === block.block_id) window.focused_block_id = window.layers.flatMap((l) => l.blocks)[0] ?? null;
  if (closeEmpty && window.layers.every((l) => l.blocks.length === 0)) {
    state.windows = state.windows.filter((w) => w !== window);
    const session = sessionById(state, window.session_id);
    if (session?.active_window_id === window.window_id) {
      session.active_window_id = state.windows.find((w) => w.session_id === session.session_id)?.window_id ?? null;
    }
  }
}

function checkBounds(bounds) {
  const rect = Array.isArray(bounds) ? bounds : bounds && typeof bounds === "object" ? [bounds.x, bounds.y, bounds.w, bounds.h] : null;
  if (!rect || rect.length !== 4 || rect.some((n) => typeof n !== "number" || !Number.isFinite(n))) fail("bad_request", "bounds is [x, y, w, h]");
  const [x, y, w, h] = rect;
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > 1 + 1e-9 || y + h > 1 + 1e-9) fail("bad_request", "bounds must fit inside the window");
  return rect;
}

function layerOf(state, sessionId, layerId) {
  const found = state.windows.filter((w) => w.session_id === sessionId).flatMap((w) => w.layers.map((l) => ({ window: w, layer: l }))).find((x) => x.layer.layer_id === layerId);
  if (!found) fail("not_found", `layer ${layerId} is not in the session`);
  return found;
}

function contains(node, id) {
  return leafIds(node).includes(id);
}

function innermostSplit(node, direction, before, after) {
  if (!node?.split) return null;
  for (const side of ["before", "after"]) {
    const inner = innermostSplit(node.split[side], direction, before, after);
    if (inner) return inner;
  }
  return node.split.direction === direction && contains(node.split.before, before) && contains(node.split.after, after) ? node.split : null;
}

function viewLayout(node, rect) {
  if (!node) return null;
  if (node.block_id) return { rect, block_id: node.block_id };
  const { split_id, direction, ratio, before, after } = node.split;
  const [x, y, w, h] = rect;
  const first = direction === "horizontal" ? [x, y, w * ratio, h] : [x, y, w, h * ratio];
  const second = direction === "horizontal" ? [x + w * ratio, y, w * (1 - ratio), h] : [x, y + h * ratio, w, h * (1 - ratio)];
  return { rect, split: { split_id, direction, ratio, before: viewLayout(before, first), after: viewLayout(after, second) } };
}

function closeBlock(state, block) {
  killProcess(block);
  forgetRelay(state, block);
  removeFromWindow(state, block);
  delete state.blocks[block.block_id];
  state.closed.push(block.block_id);
}

function exitOf(block) {
  const file = join(block.dir, "exit.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

function screenOf(block) {
  const banner = loginWrapped(block) ? "Last login: Thu Jan  1 00:00:00 on ttys000\n" : "";
  return Buffer.concat([Buffer.from(banner), rawScreenOf(block)]);
}

function rawScreenOf(block) {
  const big = join(block.dir, "screen");
  if (existsSync(big)) return readFileSync(big);
  if (block.screen !== null) return Buffer.from(block.screen);
  const file = join(block.dir, "output");
  return existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
}

const ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function formatted(block, format) {
  if (!["text", "html", "vt"].includes(format)) fail("bad_request", `format must be text, html or vt, not ${format}`);
  const rows = screenOf(block).toString("utf8").split(/\r?\n/);
  if (rows.at(-1) === "") rows.pop();
  if (format === "vt") {
    while (rows.length < block.size.rows) rows.push("");
    return Buffer.from(rows.join("\r\n"));
  }
  const text = rows.map((r) => r.replace(ESCAPES, ""));
  while (text.length > 0 && text.at(-1).trim() === "") text.pop();
  return Buffer.from(text.join("\n"));
}

function jsonBoundedSlice(buf, start, maxBytes) {
  let end = Math.min(buf.length, start + maxBytes);
  for (;;) {
    const data = buf.subarray(start, end).toString("utf8");
    if (JSON.stringify(data).length - 2 <= maxBytes || end <= start) return data;
    end = start + Math.floor((end - start) * 0.9);
  }
}

function runningProgram(pid) {
  let args = "";
  try {
    args = execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {}
  const words = args.split(/\s+/).filter(Boolean);
  const script = basename(words[0] ?? "") === "node" && words[1] && !words[1].startsWith("-") ? words[1] : undefined;
  return { name: basename(words[0] ?? ""), argv0: words[0] ?? "", path: words[0] ?? "", invoked_path: words[0] ?? "", ...(script ? { script } : {}) };
}

function processInfo(block) {
  const raw = exitOf(block);
  const { at: _at, ...ended } = raw ?? {};
  const exit = raw && loginWrapped(block) ? { exit_code: 0 } : raw ? ended : null;
  if (loginWrapped(block) && block.child_pid && !exit) {
    const login = { pid: block.child_pid, name: "login", argv0: null, cwd: block.cwd, user: process.env.USER ?? "", user_id: process.getuid?.() ?? 0 };
    return { child: login, foreground: login, home: FAKE_HOME, last_exit: null };
  }
  const program = block.restored ? null : execedProgram(block.command);
  const seen = block.restored ? runningProgram(block.child_pid) : { name: basename(program), argv0: program, path: program, invoked_path: program };
  const proc = block.child_pid && !exit
    ? { pid: block.child_pid, ...seen, cwd: block.cwd, user: process.env.USER ?? "", user_id: process.getuid?.() ?? 0 }
    : null;
  if (exit) return { home: FAKE_HOME, last_exit: exit };
  return proc ? { child: proc, foreground: proc, home: FAKE_HOME, last_exit: null } : { home: FAKE_HOME, last_exit: null };
}

function feed(block, text) {
  appendFileSync(join(block.dir, "input"), text);
}

const KEY_BYTES = { enter: "\n", tab: "\t", escape: "\x1b", "shift+tab": "\x1b[Z", up: "\x1b[A", down: "\x1b[B" };

function sendKey(block, key) {
  block.events.push({ type: "key", payload: { key } });
  if (key === "ctrl+c") {
    try {
      if (block.child_pid) process.kill(block.child_pid, "SIGINT");
    } catch {}
  } else if (KEY_BYTES[key] !== undefined) {
    feed(block, KEY_BYTES[key]);
  }
}

function portsReply(block) {
  const ports = Date.now() >= (block.ports_at ?? 0) ? block.ports ?? [] : [];
  const pids = [...new Set(ports.map((p) => p.pid).filter((pid) => pid !== undefined))].sort((a, b) => a - b);
  const describe = (list) => pids.filter((pid) => list.some((p) => p.pid === pid)).map((pid) => ({ pid, user_id: process.getuid?.() ?? 0, name: "node" }));
  const status = block.ports_status ?? "ok";
  const keep = block.ports_keep;
  if (keep === undefined || ports.length <= keep) return { status, ports, processes: describe(ports) };
  const id = (block.blob_seq = (block.blob_seq ?? 0) + 1);
  writeFileSync(join(block.dir, `blob-${id}`), JSON.stringify({ status, ports, processes: describe(ports) }));
  const head = ports.slice(0, keep);
  return { id, status, ports: head, processes: describe(head), truncated: true };
}

function blockMethod(state, params, method, args) {
  const block = requireBlock(state, params);
  switch (method) {
    case "process":
      return processInfo(block);
    case "format": {
      const all = formatted(block, args?.format ?? "text");
      const max = args?.max_bytes;
      if (!max || all.length <= max) return { content: all.toString("utf8") };
      const id = (block.blob_seq = (block.blob_seq ?? 0) + 1);
      writeFileSync(join(block.dir, `blob-${id}`), all);
      const head = { id, total: all.length, content: jsonBoundedSlice(all, 0, max) };
      if (process.env.FAKE_REX_FORMAT_NO_TOTAL === "1") delete head.total;
      return head;
    }
    case "blob_read": {
      const file = join(block.dir, `blob-${args?.id}`);
      if (!existsSync(file)) fail("not_found", `no blob ${args?.id}`);
      const all = readFileSync(file);
      const start = args?.offset ?? 0;
      const data = jsonBoundedSlice(all, start, Math.min(args?.max_bytes || 49152, 983040));
      return { id: args.id, total: all.length, eof: start + Buffer.byteLength(data) >= all.length, data };
    }
    case "title":
      return { title: block.title ?? block.label, owner: null };
    case "modes":
      return { screen: "primary", modes: [{ name: "bracketed_paste", number: 2004, ansi: false, set: block.bracketed !== false, default: false }] };
    case "program_status":
      return { records: block.program_status };
    case "ports":
      return portsReply(block);
    case "resize":
      block.size = { columns: args?.columns ?? block.size.columns, rows: args?.rows ?? block.size.rows };
      return {};
    case "size":
      return { ...block.size };
    default:
      fail("method_not_found", `block has no method ${method}`);
  }
}

function viewOf(state, session) {
  return {
    session_id: session.session_id,
    label: session.label,
    revision: state.revision,
    active_window_id: session.active_window_id,
    windows: state.windows
      .filter((w) => w.session_id === session.session_id)
      .map((w) => ({
        window_id: w.window_id,
        label: w.label,
        focused_block_id: w.focused_block_id,
        zoomed_block_id: null,
        tiled_zoomed_block_id: null,
        layers: w.layers.map((l) => ({
          layer_id: l.layer_id,
          kind: l.kind,
          bounds: l.bounds,
          layout: viewLayout(l.tree, l.bounds),
          ...(l.state === "minimized" ? { state: "minimized" } : {}),
          blocks: l.blocks.map((id) => {
            const b = state.blocks[id];
            return { block_id: id, label: b.label, flavor: b.flavor, creator_name: TERMINAL, host_id: "fake-host", owner: null };
          }),
        })),
      })),
  };
}

function resolveTargets(state, params) {
  const kinds = params.kinds?.length ? params.kinds : ["session", "window", "block"];
  const scopeId = state.blocks[params.scope?.session]?.session_id ?? params.scope?.session;
  const scope = params.scope?.session ? state.sessions.find((s) => s.session_id === scopeId || s.label === scopeId) : null;
  if (params.scope?.session && kinds.includes("session")) fail("bad_request", "scope is not allowed when kinds includes session");
  const inScope = (sid) => !params.scope?.session || sid === scope?.session_id;
  const matches = (id, label, q) => id === q || id.endsWith(q) || (label && label === q);
  return {
    results: (params.queries ?? []).map((query) => {
      const found = [];
      if (kinds.includes("session")) {
        const holder = !kinds.includes("block") ? state.blocks[query]?.session_id : undefined;
        for (const s of state.sessions) if (inScope(s.session_id) && (s.session_id === holder || matches(s.session_id, s.label, query))) found.push({ kind: "session", session_id: s.session_id, label: s.label, where: "server" });
      }
      if (kinds.includes("window")) {
        for (const w of state.windows) if (inScope(w.session_id) && matches(w.window_id, w.label, query)) found.push({ kind: "window", session_id: w.session_id, window_id: w.window_id, label: w.label, where: "session" });
      }
      if (kinds.includes("block")) {
        for (const b of Object.values(state.blocks)) {
          if (inScope(b.session_id) && matches(b.block_id, b.label, query)) {
            found.push({ kind: "block", session_id: b.session_id, window_id: b.window_id ?? undefined, block_id: b.block_id, label: b.label, where: b.window_id ? "window" : "detached" });
          }
        }
      }
      if (found.length === 1) return { query, status: "resolved", target: found[0] };
      if (found.length === 0) return { query, status: "not_found" };
      return { query, status: "ambiguous", candidates: found };
    }),
  };
}

function anchorWindow(state, block) {
  if (!block.window_id) fail("not_found", `block ${block.block_id} is not in a window`);
  const window = windowById(state, block.window_id);
  return { window, layer: window.layers.find((l) => l.layer_id === block.layer_id) };
}

const SCHEMAS = {
  "session.new_window": { keys: ["focus", "layout", "session_id", "window_label"], required: ["session_id", "layout"] },
  "session.new_split": { keys: ["anchor_id", "direction", "focus", "layout", "ratio", "session_id", "side", "window_id"], required: ["session_id", "direction", "side", "layout"] },
  "session.new_block": { keys: ["flavor", "label", "options", "session_id"], required: ["session_id", "flavor"] },
  "session.create": { keys: ["initial_windows", "label"], required: [] },
  "session.set_block_label": { keys: ["block_id", "label", "session_id"], required: ["session_id", "block_id"] },
  "session.set_window_label": { keys: ["label", "session_id", "window_id"], required: ["session_id", "window_id"] },
  "target.resolve": { keys: ["context", "kinds", "queries", "scope"], required: ["kinds", "queries"] },
  "session.move_block": { keys: ["anchor_block_id", "block_id", "direction", "ratio", "session_id", "side"], required: ["session_id", "block_id", "anchor_block_id"] },
  "block.close": { keys: ["block_id", "keep_last", "session_id", "undoable", "window_id"], required: ["session_id"] },
  "session.float_block": { keys: ["block_id", "bounds", "session_id"], required: ["session_id", "block_id", "bounds"] },
  "session.set_layer_state": { keys: ["focus", "layer_id", "session_id", "state"], required: ["session_id", "layer_id", "state"] },
  "session.resize_layer": { keys: ["bounds", "layer_id", "session_id"], required: ["session_id", "layer_id", "bounds"] },
  "session.detach_block": { keys: ["block_id", "session_id"], required: ["session_id", "block_id"] },
  "session.resize_pane": { keys: ["after_block_id", "before_block_id", "direction", "ratio", "session_id"], required: ["session_id", "direction", "before_block_id", "after_block_id", "ratio"] },
  "session.view": { keys: ["session_id"], required: ["session_id"] },
  "session.focus_block": { keys: ["block_id", "session_id"], required: ["session_id", "block_id"] },
  "client.list": { keys: ["kinds", "session_id"], required: [] },
  "client.perform": { keys: ["action", "args", "block_id", "client_id", "origin", "session_id", "timeout_ms"], required: ["client_id", "action"] },
};

const checkRatio = (ratio) => {
  if (ratio !== undefined && !(typeof ratio === "number" && ratio > 0 && ratio < 1)) fail("bad_request", "ratio is between 0 and 1");
};
const checkEnum = (value, allowed, name) => {
  if (value !== undefined && value !== null && !allowed.includes(value)) fail("bad_request", `${name} is ${allowed.join(" or ")}`);
};

function checkSchema(method, params) {
  const schema = SCHEMAS[method];
  if (!schema) return;
  for (const key of Object.keys(params)) if (!schema.keys.includes(key)) fail("bad_request", `${method} has no argument ${key}`);
  for (const key of schema.required) if (params[key] === undefined || params[key] === null) fail("bad_request", `${method} needs ${key}`);
  if (method === "session.new_split" && !["horizontal", "vertical"].includes(params.direction)) fail("bad_request", "direction is horizontal or vertical");
  if (method === "session.new_split" && !["before", "after"].includes(params.side)) fail("bad_request", "side is before or after");
  if (method === "session.move_block" && ![undefined, null, "horizontal", "vertical"].includes(params.direction)) fail("bad_request", "direction is horizontal or vertical");
  if (method === "session.move_block" && ![undefined, null, "before", "after"].includes(params.side)) fail("bad_request", "side is before or after");
}

function apiCall(state, method, params) {
  if (process.env.FAKE_REX_FAIL_ON === method) fail("internal", `injected failure on ${method}`);
  checkSchema(method, params);
  if (method.startsWith(`${TERMINAL}.`)) return blockMethod(state, params, method.slice(TERMINAL.length + 1), params.args ?? {});
  switch (method) {
    case "server.status":
      return { status: "running", address: state.address };
    case "session.list":
      return { sessions: state.sessions.map((s) => ({ session_id: s.session_id, label: s.label })) };
    case "session.create": {
      if (params.label && state.sessions.some((s) => s.label === params.label)) fail("conflict", `a session is labelled ${params.label}`);
      const session = { session_id: `session:${randomUUID()}`, label: params.label || `fake-${state.sessions.length + 1}`, active_window_id: null };
      state.sessions.push(session);
      const initial = (params.initial_windows ?? []).map((w) => createWindow(state, session, w.window_label, w.layout));
      const revision = nextRevision(state);
      return { session_id: session.session_id, initial_windows: initial.map(({ window, blocks }) => ({ window_id: window.window_id, block_ids: blocks.map((b) => b.block_id), revision })) };
    }
    case "session.view":
      return viewOf(state, requireSession(state, params.session_id));
    case "session.list_blocks": {
      requireSession(state, params.session_id);
      const blocks = Object.values(state.blocks).filter((b) => b.session_id === params.session_id).sort((a, b) => a.block_id.localeCompare(b.block_id));
      return {
        blocks: blocks.map((b) => ({ block_id: b.block_id, label: b.label, creator_name: TERMINAL, flavor: b.flavor, host_id: "fake-host", placement: b.window_id ? "placed" : "detached", ...(b.window_id ? { window_id: b.window_id } : {}), owner: null })),
      };
    }
    case "session.new_window": {
      const session = requireSession(state, params.session_id);
      const { window, blocks } = createWindow(state, session, params.window_label, params.layout);
      if (params.focus) session.active_window_id = window.window_id;
      return { window_id: window.window_id, block_ids: blocks.map((b) => b.block_id), revision: nextRevision(state) };
    }
    case "session.new_split": {
      const session = requireSession(state, params.session_id);
      if (params.anchor_id && params.window_id) fail("bad_request", "send anchor_id or window_id, not both");
      checkRatio(params.ratio);
      let window;
      let layer;
      let anchorId = params.anchor_id ?? null;
      if (anchorId) {
        const anchor = state.blocks[anchorId];
        if (anchor) {
          if (anchor.session_id !== session.session_id) fail("not_found", `anchor ${anchorId} is not in the session`);
          ({ window, layer } = anchorWindow(state, anchor));
        } else {
          const hit = state.windows.filter((w) => w.session_id === session.session_id).flatMap((w) => w.layers.map((l) => ({ window: w, layer: l }))).find((x) => replaceNode(structuredClone(x.layer.tree), anchorId, (n) => n));
          if (!hit) fail("not_found", `anchor ${anchorId} is not in the session`);
          ({ window, layer } = hit);
        }
      } else {
        window = params.window_id ? windowById(state, params.window_id) : windowById(state, session.active_window_id);
        if (params.window_id && (!window || window.session_id !== session.session_id)) fail("not_found", `window ${params.window_id} is not in the session`);
        if (!window) fail("conflict", "the session has no windows");
        layer = window.layers[0];
        anchorId = window.focused_block_id && window.layers[0].blocks.includes(window.focused_block_id) ? window.focused_block_id : window.layers[0].blocks[0];
      }
      const inserted = buildTree(state, session.session_id, params.layout);
      if (anchorId) insertBeside(layer, anchorId, inserted, params.direction, params.side, params.ratio);
      else layer.tree = inserted;
      syncLayer(state, window, layer);
      const blocks = leafIds(inserted);
      if (params.focus && blocks[0]) window.focused_block_id = blocks[0];
      return { anchor_id: anchorId, block_ids: blocks, split_ids: blocks.map(() => `split:${randomUUID()}`), revision: nextRevision(state) };
    }
    case "session.new_block": {
      requireSession(state, params.session_id);
      const block = createBlock(state, params.session_id, { flavor: params.flavor, label: params.label, options: params.options });
      return { block_id: block.block_id, revision: nextRevision(state) };
    }
    case "session.move_block": {
      checkRatio(params.ratio);
      checkEnum(params.direction, ["horizontal", "vertical"], "direction");
      checkEnum(params.side, ["before", "after"], "side");
      if (params.block_id === params.anchor_block_id) fail("bad_request", "block_id and anchor_block_id are the same");
      const block = requireBlock(state, params);
      const anchor = requireBlock(state, { session_id: params.session_id, block_id: params.anchor_block_id });
      anchorWindow(state, anchor);
      removeFromWindow(state, block);
      const { window, layer } = anchorWindow(state, anchor);
      insertBeside(layer, anchor.block_id, { block_id: block.block_id }, params.direction ?? "horizontal", params.side ?? "after", params.ratio);
      syncLayer(state, window, layer);
      return { created_split_id: `split:${randomUUID()}`, removed_split_id: null, revision: nextRevision(state) };
    }
    case "session.float_block": {
      const block = requireBlock(state, params);
      const rect = checkBounds(params.bounds);
      const { window, layer: from } = anchorWindow(state, block);
      if (from.kind !== "tiled") fail("bad_request", `block ${block.block_id} is already in a floating layer`);
      removeFromWindow(state, block, { closeEmpty: false });
      const layer = { layer_id: `layer:${randomUUID()}`, kind: "floating", state: "normal", bounds: rect, blocks: [], tree: { block_id: block.block_id } };
      window.layers.push(layer);
      syncLayer(state, window, layer);
      return { layer_id: layer.layer_id, revision: nextRevision(state) };
    }
    case "session.set_layer_state": {
      requireSession(state, params.session_id);
      checkEnum(params.state, ["normal", "minimized"], "state");
      const { window, layer } = layerOf(state, params.session_id, params.layer_id);
      if (params.state === "minimized" && layer.kind === "tiled") fail("bad_request", "the window's layout cannot be minimized");
      if (params.focus && (params.state === "minimized" || layer.blocks.length === 0)) fail("bad_request", "focus needs a normal layer with a block");
      if (params.state === "minimized" && !window.layers.some((l) => l !== layer && l.state !== "minimized" && l.blocks.length > 0)) fail("bad_request", "a window must keep a visible pane");
      layer.state = params.state;
      if (params.focus) {
        window.focused_block_id = layer.blocks[0];
        sessionById(state, params.session_id).active_window_id = window.window_id;
        if (layer.kind !== "tiled") window.layers.push(...window.layers.splice(window.layers.indexOf(layer), 1));
      }
      return { revision: nextRevision(state) };
    }
    case "session.resize_layer": {
      requireSession(state, params.session_id);
      const rect = checkBounds(params.bounds);
      const { layer } = layerOf(state, params.session_id, params.layer_id);
      if (layer.kind === "tiled") fail("bad_request", "the window's layout is not a floating layer");
      layer.bounds = rect;
      return { revision: nextRevision(state) };
    }
    case "session.detach_block":
      removeFromWindow(state, requireBlock(state, params));
      return { revision: nextRevision(state) };
    case "session.set_block_label":
      requireBlock(state, params).label = params.label ?? "";
      return { revision: nextRevision(state) };
    case "session.set_window_label": {
      requireSession(state, params.session_id);
      const window = windowById(state, params.window_id);
      if (!window || window.session_id !== params.session_id) fail("not_found", `window ${params.window_id} is not in the session`);
      window.label = params.label ?? "";
      return { revision: nextRevision(state) };
    }
    case "session.focus_block": {
      const block = requireBlock(state, params);
      const { window } = anchorWindow(state, block);
      window.focused_block_id = block.block_id;
      sessionById(state, params.session_id).active_window_id = window.window_id;
      return { revision: nextRevision(state) };
    }
    case "session.resize_pane": {
      checkEnum(params.direction, ["horizontal", "vertical"], "direction");
      if (!(typeof params.ratio === "number" && params.ratio > 0 && params.ratio < 1)) fail("bad_request", "ratio is between 0 and 1");
      if (params.before_block_id === params.after_block_id) fail("bad_request", "the two blocks are the same");
      const before = requireBlock(state, { session_id: params.session_id, block_id: params.before_block_id });
      const after = requireBlock(state, { session_id: params.session_id, block_id: params.after_block_id });
      if (!before.window_id || !after.window_id) fail("not_found", "both blocks must be in a window");
      if (before.layer_id !== after.layer_id) fail("bad_request", "the blocks are in different windows or layers");
      const { layer } = anchorWindow(state, before);
      const split = innermostSplit(layer.tree, params.direction, before.block_id, after.block_id);
      if (!split) fail("bad_request", "no split between the blocks matches");
      split.ratio = params.ratio;
      return { revision: nextRevision(state) };
    }
    case "target.resolve":
      if (!params.queries?.length) fail("bad_request", "send at least one query");
      return resolveTargets(state, params);
    case "block.event": {
      const block = requireBlock(state, params);
      const event = params.event;
      if (!event?.type) fail("bad_request", "event.type is required");
      if (event.type === "paste") {
        if (typeof event.payload?.text !== "string") fail("bad_request", "a paste payload is {text}");
        block.events.push({ type: "paste", payload: { text: event.payload.text } });
        feed(block, event.payload.text);
      } else if (event.type === "key") {
        sendKey(block, event.payload?.key);
      } else {
        block.events.push({ type: event.type, payload: event.payload ?? {} });
      }
      return {};
    }
    case "block.close": {
      if (Boolean(params.block_id) === Boolean(params.window_id)) fail("bad_request", "send exactly one of block_id and window_id");
      requireSession(state, params.session_id);
      const id = params.block_id ?? windowById(state, params.window_id)?.focused_block_id;
      const block = requireBlock(state, { session_id: params.session_id, block_id: id });
      closeBlock(state, block);
      return { block_id: block.block_id, revision: nextRevision(state) };
    }
    case "block.method":
      if (!params.block_id) fail("bad_request", "block_id is required");
      return blockMethod(state, params, String(params.method ?? "").replace(`${TERMINAL}.`, ""), params.args ?? {});
    case "client.list": {
      const clients = (state.clients ?? []).filter((c) => !params.kinds?.length || params.kinds.includes(c.info?.kind));
      return { clients: clients.filter((c) => !params.session_id || (c.session_ids ?? []).includes(params.session_id)) };
    }
    case "client.perform": {
      if (!(state.clients ?? []).some((c) => c.client_id === params.client_id)) fail("not_found", `no client ${params.client_id} is connected`);
      if (state.perform_error) fail(state.perform_error, `client ${params.client_id} did not perform ${params.action}`);
      state.performed.push({ client_id: params.client_id, action: params.action, args: params.args ?? null, session_id: params.session_id ?? null });
      return { performed_by: params.client_id };
    }
    default:
      fail("method_not_found", `the fake does not implement ${method}`);
  }
}

const luaJson = (value) => (Array.isArray(value) && value.length === 0 ? {} : value);

function attachesEachSession(code) {
  const attach = code.search(/rex\.session\.attach\s*[{(]/);
  return attach >= 0 && attach < code.indexOf("session.list_blocks");
}

function snapshot(state, args, code, callerSession) {
  const wanted = new Set(args?.blocks ?? []);
  const blocks = {};
  const attaches = attachesEachSession(code);
  let incomplete = false;
  for (const s of state.sessions) {
    if (!attaches && s.session_id !== callerSession && s.label !== callerSession) {
      incomplete = true;
      continue;
    }
    for (const b of Object.values(state.blocks).filter((x) => x.session_id === s.session_id && !x.hidden)) {
      const entry = { session_id: s.session_id, session_label: s.label ?? "", window_id: b.window_id ?? "", label: b.label ?? "", placement: b.window_id ? "placed" : "detached", probed: false };
      if (wanted.has(b.block_id)) {
        const proc = processInfo(b);
        entry.probed = true;
        entry.process = { ...proc };
        if (proc.last_exit === null) delete entry.process.last_exit;
        entry.program_status = { records: luaJson(b.program_status) };
      }
      blocks[b.block_id] = entry;
    }
  }
  return { version: 1, incomplete, blocks };
}

function parseParams(raw) {
  if (raw === undefined) return {};
  const text = raw === "-" ? readFileSync(0, "utf8") : raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
  try {
    return JSON.parse(text);
  } catch {
    fail("bad_request", "ARGS must be a JSON object");
  }
}

function resolveBlockRef(state, ref) {
  const hits = Object.values(state.blocks).filter((b) => b.block_id === ref || b.block_id.endsWith(ref) || b.label === ref);
  if (hits.length !== 1) fail("not_found", `no single block matches ${ref}`);
  return hits[0];
}

function fakeOp(op, raw) {
  const args = raw ? JSON.parse(raw) : {};
  return withLock((state) => {
    switch (op) {
      case "stopServer":
        state.server = "stopped";
        return {};
      case "restartServer":
        for (const block of Object.values(state.blocks)) {
          const record = resumeRecord(block);
          killProcess(block);
          forgetRelay(state, block);
          block.command = args.trust === true && record ? record.argv : ["/bin/sh"];
          block.restored = true;
          block.fresh_env = freshEnv(args.env ?? {});
          startProcess(state, block);
        }
        state.server = "running";
        return {};
      case "closeBlock": {
        const block = state.blocks[args.block_id];
        if (block) closeBlock(state, block);
        return {};
      }
      case "transferWindow": {
        const window = windowById(state, args.window_id);
        if (!window) fail("not_found", `window ${args.window_id}`);
        let target = args.session_id ? sessionById(state, args.session_id) : state.sessions.find((s) => s.label === args.session_label);
        if (!target) {
          target = { session_id: `session:${randomUUID()}`, label: args.session_label ?? `fake-${state.sessions.length + 1}`, active_window_id: null };
          state.sessions.push(target);
        }
        const from = sessionById(state, window.session_id);
        window.session_id = target.session_id;
        for (const id of window.layers.flatMap((l) => l.blocks)) state.blocks[id].session_id = target.session_id;
        if (from?.active_window_id === window.window_id) from.active_window_id = state.windows.find((w) => w.session_id === from.session_id)?.window_id ?? null;
        if (!target.active_window_id) target.active_window_id = window.window_id;
        return { session_id: target.session_id };
      }
      case "setScreen":
        state.blocks[args.block_id].screen = args.text;
        return {};
      case "setScreenFile":
        writeFileSync(join(state.blocks[args.block_id].dir, "screen"), readFileSync(args.file));
        return {};
      case "hideFromSnapshot":
        state.blocks[args.block_id].hidden = true;
        return {};
      case "setBracketedPaste":
        state.blocks[args.block_id].bracketed = args.on;
        return {};
      case "setTitle":
        state.blocks[args.block_id].title = args.title;
        return {};
      case "setProgramStatus":
        state.blocks[args.block_id].program_status = args.records ?? [];
        return {};
      case "setClients":
        state.clients = args.clients ?? [];
        state.perform_error = args.perform_error ?? null;
        return {};
      case "setPorts": {
        const block = state.blocks[args.block_id];
        const pid = block.child_pid ?? undefined;
        block.ports = (args.ports ?? []).map((p) => ({ address: "127.0.0.1", protocol: "tcp", first_seen_at: new Date().toISOString(), ...(pid === undefined ? {} : { pid }), ...p }));
        block.ports_at = Date.now() + (args.after_ms ?? 0);
        block.ports_status = args.status ?? "ok";
        block.ports_keep = args.keep;
        return {};
      }
      default:
        fail("bad_request", `unknown fake op ${op}`);
    }
  });
}

function waitFor(ref, forDuration, json) {
  const state = readState();
  const block = resolveBlockRef(state, ref);
  const deadline = forDuration ? Date.now() + durationMs(forDuration) : Infinity;
  for (;;) {
    const exit = exitOf(block);
    if (exit) {
      if (json) process.stdout.write(`${JSON.stringify({ type: "exit", block_id: block.block_id, ...exit })}\n`);
      return (exit.exit_code ?? 1) % 256;
    }
    if (!readState().blocks[block.block_id]) return 1;
    if (Date.now() > deadline) {
      process.stderr.write("Error: wait gave up\n");
      return 1;
    }
    sleepMs(50);
  }
}

function durationMs(text) {
  let total = 0;
  for (const [, n, unit] of String(text).matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) total += Number(n) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  return total;
}

function socketPathOf(url) {
  return decodeURIComponent(String(url).replace(/^unix:\/\//, ""));
}

function emit(value, silent = false) {
  if (!silent) process.stdout.write(`${JSON.stringify(value)}\n`);
}

function main(argv) {
  appendFileSync(CALLS, `${JSON.stringify({ argv, pid: process.pid, t: Date.now() })}\n`);
  if (argv[0] === "__fake") {
    emit(fakeOp(argv[1], argv[2]));
    return 0;
  }
  if (process.env.FAKE_REX_HANG === "1") {
    setInterval(() => {}, 1 << 30);
    return null;
  }
  const { global, rest } = parseArgs(argv);
  if (global.autostart !== "false") {
    process.stderr.write("fake rex: refusing a call without --autostart=false\n");
    return 3;
  }
  if (!global.timeout) {
    process.stderr.write("fake rex: refusing a call without --timeout\n");
    return 3;
  }
  if (process.env.FAKE_REX_SELF_KILL) {
    process.kill(process.pid, process.env.FAKE_REX_SELF_KILL);
    sleepMs(5000);
  }
  if (process.env.FAKE_REX_SLOW_EXIT1 === "1") {
    sleepMs(durationMs(global.timeout));
    process.stderr.write("Error: fake slow failure\n");
    return 1;
  }
  const state = readState();
  const server = global.server ?? process.env.REX_SERVER ?? state.address;
  if (state.server !== "running" || server !== state.address) {
    process.stderr.write(`Error: no Rex server is running at ${socketPathOf(server)}, and autostart is disabled\n`);
    return 4;
  }
  withLock(reapCompleted);
  const [cmd, ...tail] = rest;
  switch (cmd) {
    case "whoami": {
      const f = flags(tail, { "--json": "json?" });
      const who = {
        principal: { kind: "local", transport: "unix", display: "fake-user", uid: 1000, gid: 1000, pid: process.ppid },
        account: "fake-account",
        endpoint: state.address,
        pid: process.pid,
        instance_id: "fake-instance",
        host_id: "fake-host",
        started_at: "2026-01-01T00:00:00Z",
        rex_version: "0.0.0-fake",
        api_revision: 24,
        exit_empty: false,
        session_count: state.sessions.length,
        log_path: join(DIR, "fake-rex.log"),
        tailscale: { enabled: false },
        session_id: process.env.REX_SESSION ?? "",
        window_id: "",
        block_id: process.env.REX_BLOCK ?? "",
      };
      if (f.json) emit(who);
      else process.stdout.write(`server: ${state.address}\n`);
      return 0;
    }
    case "api": {
      if (tail[0] !== "call") fail("bad_request", `the fake supports only api call, not api ${tail[0]}`);
      const f = flags(tail.slice(1), { "-s": "session", "--session": "session" });
      const [method, raw] = f._;
      const params = parseParams(raw);
      const [sleepOn, sleepFor] = (process.env.FAKE_REX_SLEEP_ON ?? "").split(":");
      if (sleepOn === method) sleepMs(Number(sleepFor) || 0);
      emit(withLock((s) => {
        if (f.session && !params.session_id) {
          const found = s.sessions.find((x) => x.session_id === f.session || x.label === f.session);
          if (!found) fail("session_not_found", `session ${f.session}`);
          params.session_id = found.session_id;
        }
        return apiCall(s, method, params);
      }), process.env.FAKE_REX_EMPTY_ON === method);
      return 0;
    }
    case "send-key": {
      const f = flags(tail, { "-b": "block", "--block": "block", "-s": "session", "--session": "session", "-w": "window", "--window": "window", "--action": "action" });
      if (!f.block) fail("bad_request", "the fake needs -b BLOCK");
      withLock((s) => {
        const block = resolveBlockRef(s, f.block);
        if (f.session && block.session_id !== f.session && sessionById(s, block.session_id)?.label !== f.session) fail("not_found", `block ${f.block} is not in session ${f.session}`);
        for (const key of f._) sendKey(block, key);
      });
      return 0;
    }
    case "wait": {
      const f = flags(tail, { "--for": "for", "-s": "session", "--session": "session", "-w": "window", "--window": "window", "--json": "json?" });
      return waitFor(f._[0], f.for, f.json);
    }
    case "do": {
      const f = flags(tail, { "-e": "code", "--eval": "code", "--json": "json?", "-s": "session", "-b": "block", "--args": "args" });
      if (typeof f.code !== "string" || f.code.split("\n")[0] !== SNAPSHOT_HEADER) fail("bad_request", "the fake runs only the hive snapshot script");
      const snap = snapshot(readState(), f.args ? parseParams(f.args) : {}, f.code, f.session ?? process.env.REX_SESSION ?? "");
      if (f.json) emit(snap);
      else process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
      return 0;
    }
    default:
      fail("bad_request", `the fake does not implement ${cmd ?? "(no command)"}`);
  }
}

let code;
try {
  code = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(err instanceof ApiError ? `Error: ${err.code}: ${err.message}\n` : `fake rex: ${err.stack ?? err}\n`);
  code = 1;
}
if (code !== null) process.exitCode = code;
