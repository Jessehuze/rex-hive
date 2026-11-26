import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY = join(HERE, "relay.mjs");
const TERMINAL = "com.superlogical.terminal";
const SNAPSHOT_HEADER = "-- hive:snapshot v1";

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

function childEnv(state, block) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("REX_") || k === "OSC7577_TOKEN" || (k.startsWith("FAKE_REX_") && k !== "FAKE_REX_STATE" && k !== "FAKE_REX_OWNER")) continue;
    env[k] = v;
  }
  env.REX_SERVER = state.address;
  env.REX_BLOCK = block.block_id;
  env.REX_SESSION = block.session_id;
  return env;
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

function placeInLayer(state, block, window, layer, index) {
  layer.blocks.splice(index ?? layer.blocks.length, 0, block.block_id);
  block.window_id = window.window_id;
  block.layer_id = layer.layer_id;
  if (!window.focused_block_id) window.focused_block_id = block.block_id;
}

function createWindow(state, session, label, layout) {
  const window = {
    window_id: `window:${randomUUID()}`,
    session_id: session.session_id,
    label: label ?? "",
    focused_block_id: null,
    layers: [{ layer_id: `layer:${randomUUID()}`, kind: "tiled", state: "normal", bounds: [], blocks: [] }],
  };
  state.windows.push(window);
  const blocks = leaves(layout).map((spec) => createBlock(state, session.session_id, spec));
  for (const block of blocks) placeInLayer(state, block, window, window.layers[0]);
  if (!session.active_window_id) session.active_window_id = window.window_id;
  return { window, blocks };
}

function removeFromWindow(state, block, { closeEmpty = true } = {}) {
  const window = windowById(state, block.window_id);
  block.window_id = null;
  block.layer_id = null;
  if (!window) return;
  for (const layer of window.layers) layer.blocks = layer.blocks.filter((id) => id !== block.block_id);
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
  const big = join(block.dir, "screen");
  if (existsSync(big)) return readFileSync(big);
  if (block.screen !== null) return Buffer.from(block.screen);
  const file = join(block.dir, "output");
  return existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
}

function processInfo(block) {
  const exit = exitOf(block);
  const proc = block.child_pid && !exit
    ? { pid: block.child_pid, name: basename(block.command[0]), argv0: block.command[0], path: block.command[0], invoked_path: block.command[0], cwd: block.cwd, user: process.env.USER ?? "", user_id: process.getuid?.() ?? 0 }
    : null;
  return { child: proc, foreground: proc, ancestors: [], home: process.env.HOME ?? "", last_exit: exit };
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

function blockMethod(state, params, method, args) {
  const block = requireBlock(state, params);
  switch (method) {
    case "process":
      return processInfo(block);
    case "format": {
      const all = screenOf(block);
      const max = args?.max_bytes;
      if (!max) return { content: all.toString("utf8") };
      if (all.length <= max) return { content: all.toString("utf8"), total: all.length, eof: true };
      return { content: all.subarray(0, max).toString("utf8"), id: 7, total: all.length, eof: false };
    }
    case "blob_read": {
      const all = screenOf(block);
      const start = args?.offset ?? 0;
      const end = Math.min(all.length, start + (args?.max_bytes || 49152));
      return { data: all.subarray(start, end).toString("utf8"), id: args?.id ?? 7, total: all.length, eof: end >= all.length };
    }
    case "title":
      return { title: block.title ?? block.label, owner: null };
    case "modes":
      return { screen: "primary", modes: [{ name: "bracketed_paste", number: 2004, ansi: false, set: block.bracketed !== false, default: false }] };
    case "program_status":
      return { records: block.program_status };
    case "ports":
      return { status: "ok", ports: block.ports, processes: [], truncated: false };
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
          state: l.state,
          bounds: l.bounds,
          layout: null,
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
  const scope = params.scope?.session ? state.sessions.find((s) => s.session_id === params.scope.session || s.label === params.scope.session) : null;
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

function apiCall(state, method, params) {
  if (process.env.FAKE_REX_FAIL_ON === method) fail("internal", `injected failure on ${method}`);
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
      let window;
      let layer;
      let index;
      let anchorId = params.anchor_id ?? null;
      if (anchorId) {
        const anchor = state.blocks[anchorId];
        if (!anchor || anchor.session_id !== session.session_id) fail("not_found", `anchor ${anchorId} is not in the session`);
        ({ window, layer } = anchorWindow(state, anchor));
        index = layer.blocks.indexOf(anchorId) + (params.side === "before" ? 0 : 1);
      } else {
        window = params.window_id ? windowById(state, params.window_id) : windowById(state, session.active_window_id);
        if (params.window_id && (!window || window.session_id !== session.session_id)) fail("not_found", `window ${params.window_id} is not in the session`);
        if (!window) fail("conflict", "the session has no windows");
        layer = window.layers[0];
        anchorId = window.focused_block_id;
      }
      const blocks = leaves(params.layout).map((spec) => createBlock(state, session.session_id, spec));
      blocks.forEach((b, i) => placeInLayer(state, b, window, layer, index === undefined ? undefined : index + i));
      if (params.focus && blocks[0]) window.focused_block_id = blocks[0].block_id;
      return { anchor_id: anchorId, block_ids: blocks.map((b) => b.block_id), split_ids: blocks.map(() => `split:${randomUUID()}`), revision: nextRevision(state) };
    }
    case "session.new_block": {
      requireSession(state, params.session_id);
      const block = createBlock(state, params.session_id, { flavor: params.flavor, label: params.label, options: params.options });
      return { block_id: block.block_id, revision: nextRevision(state) };
    }
    case "session.move_block": {
      const block = requireBlock(state, params);
      const anchor = requireBlock(state, { session_id: params.session_id, block_id: params.anchor_block_id });
      anchorWindow(state, anchor);
      removeFromWindow(state, block);
      const { window, layer } = anchorWindow(state, anchor);
      placeInLayer(state, block, window, layer, layer.blocks.indexOf(anchor.block_id) + (params.side === "before" ? 0 : 1));
      return { created_split_id: `split:${randomUUID()}`, removed_split_id: null, revision: nextRevision(state) };
    }
    case "session.float_block": {
      const block = requireBlock(state, params);
      const { window } = anchorWindow(state, block);
      removeFromWindow(state, block, { closeEmpty: false });
      const layer = { layer_id: `layer:${randomUUID()}`, kind: "floating", state: "normal", bounds: params.bounds ?? [], blocks: [] };
      window.layers.push(layer);
      placeInLayer(state, block, window, layer);
      return { layer_id: layer.layer_id, revision: nextRevision(state) };
    }
    case "session.set_layer_state": {
      requireSession(state, params.session_id);
      const layer = state.windows.filter((w) => w.session_id === params.session_id).flatMap((w) => w.layers).find((l) => l.layer_id === params.layer_id);
      if (!layer) fail("not_found", `layer ${params.layer_id} is not in the session`);
      layer.state = params.state;
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
    case "session.resize_pane":
      requireBlock(state, { session_id: params.session_id, block_id: params.before_block_id });
      requireBlock(state, { session_id: params.session_id, block_id: params.after_block_id });
      return { revision: nextRevision(state) };
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
    case "client.perform":
      state.performed.push({ client_id: params.client_id, action: params.action, args: params.args ?? null });
      return { performed_by: params.client_id ?? "client:fake", result: null };
    default:
      fail("method_not_found", `the fake does not implement ${method}`);
  }
}

const luaJson = (value) => (Array.isArray(value) && value.length === 0 ? {} : value);

function snapshot(state, args) {
  const wanted = new Set(args?.blocks ?? []);
  const blocks = {};
  for (const s of state.sessions) {
    for (const b of Object.values(state.blocks).filter((x) => x.session_id === s.session_id)) {
      const entry = { session_id: s.session_id, session_label: s.label ?? "", window_id: b.window_id ?? "", label: b.label ?? "", placement: b.window_id ? "placed" : "detached", probed: false };
      if (wanted.has(b.block_id)) {
        const proc = processInfo(b);
        entry.probed = true;
        entry.process = { ...proc, ancestors: luaJson(proc.ancestors) };
        if (proc.last_exit === null) delete entry.process.last_exit;
        if (proc.child === null) delete entry.process.child;
        if (proc.foreground === null) delete entry.process.foreground;
        entry.program_status = { records: luaJson(b.program_status) };
      }
      blocks[b.block_id] = entry;
    }
  }
  return { version: 1, incomplete: false, blocks };
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
          killProcess(block);
          forgetRelay(state, block);
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
      case "setBracketedPaste":
        state.blocks[args.block_id].bracketed = args.on;
        return {};
      case "setTitle":
        state.blocks[args.block_id].title = args.title;
        return {};
      case "setProgramStatus":
        state.blocks[args.block_id].program_status = args.records ?? [];
        return {};
      case "setPorts":
        state.blocks[args.block_id].ports = args.ports ?? [];
        return {};
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

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
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
      emit(withLock((s) => {
        if (f.session && !params.session_id) {
          const found = s.sessions.find((x) => x.session_id === f.session || x.label === f.session);
          if (!found) fail("session_not_found", `session ${f.session}`);
          params.session_id = found.session_id;
        }
        return apiCall(s, method, params);
      }));
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
      const snap = snapshot(readState(), f.args ? parseParams(f.args) : {});
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
