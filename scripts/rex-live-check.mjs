#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(REPO, "dist");
const CLI = join(DIST, "cli.js");
const SERVER = join(DIST, "index.js");
const SHELL_FLAVOR = "com.superlogical.terminal.shell";
const RESTART_STATE = join(tmpdir(), "hive-live-restart-state.json");
const LIVE_LABEL = `hive-live-${process.pid}`;
const WORKERS = ["live-w1", "live-w2"];
const HOLD_WORKER = "live-hold";

const USAGE = `usage: HIVE_TEST_LIVE_REX=1 node scripts/rex-live-check.mjs [--restart-verify]

Drives a throwaway hive lead and workers on the Rex server that the rex on PATH reaches.
Opt-ins, each off unless set to 1:
  HIVE_LIVE_SELECT=1    also perform client.perform session.select (switches the Rex app's view)
  HIVE_LIVE_RESTART=1   keep the sessions after a clean run for a manual rex server restart,
                        then run again with --restart-verify
  HIVE_LIVE_FAKE_CLAUDE=1  claude on PATH is a stand-in, so steps that need a real Claude print SKIP`;

const argv = process.argv.slice(2);
const RESTART_VERIFY = argv.includes("--restart-verify");
const unknownArgs = argv.filter((a) => a !== "--restart-verify");
const opt = (name) => process.env[name] === "1";
const LIVE = opt("HIVE_TEST_LIVE_REX");
const SELECT = opt("HIVE_LIVE_SELECT");
const RESTART = opt("HIVE_LIVE_RESTART");
const FAKE_CLAUDE = opt("HIVE_LIVE_FAKE_CLAUDE");

if (!LIVE || unknownArgs.length > 0 || (RESTART_VERIFY && !RESTART)) {
  console.error(USAGE);
  if (RESTART_VERIFY && !RESTART) console.error("\n--restart-verify needs HIVE_LIVE_RESTART=1");
  process.exit(2);
}

for (const key of Object.keys(process.env)) {
  if (key.startsWith("HIVE_") || ["REX_BLOCK", "REX_SESSION", "REX_SERVER", "OSC7577_TOKEN", "TMUX", "TMUX_PANE"].includes(key)) delete process.env[key];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nonce = (n) => randomBytes(n).toString("hex");
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function until(check, timeoutMs, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try {
      value = await check();
    } catch {
      value = undefined;
    }
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(stepMs);
  }
}

const results = [];
function line(status, name, detail = "") {
  results.push({ status, name });
  console.log(`${status.padEnd(4)} ${name}${detail ? ` - ${detail}` : ""}`);
}
const note = (text) => console.log(`     ${text}`);

class Skip extends Error {}
const skip = (why) => {
  throw new Skip(why);
};
const fakeSkip = (what) => FAKE_CLAUDE && skip(`${what} needs a real Claude (HIVE_LIVE_FAKE_CLAUDE=1)`);

async function step(name, fn, needs = []) {
  const missing = needs.find(([ok]) => !ok);
  if (missing) return line("SKIP", name, `needs ${missing[1]}`);
  try {
    const detail = await fn();
    line("PASS", name, detail ?? "");
    return true;
  } catch (err) {
    if (err instanceof Skip) line("SKIP", name, err.message);
    else line("FAIL", name, err instanceof Error ? err.message : String(err));
    return false;
  }
}

function check(ok, message) {
  if (!ok) throw new Error(message);
}

function findOnPath(name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch {}
  }
  return null;
}

function installWrapper(binDir, log, realRex) {
  mkdirSync(binDir, { recursive: true });
  const wrapper = join(binDir, "rex");
  writeFileSync(wrapper, ["#!/bin/sh", `printf '%s\\037' "$@" >> ${q(log)}`, `printf '\\036' >> ${q(log)}`, `exec ${q(realRex)} "$@"`, ""].join("\n"));
  chmodSync(wrapper, 0o755);
  if (!existsSync(log)) writeFileSync(log, "");
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
}

function readCalls(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\x1e")
    .filter((r) => r.length > 0)
    .map((r) => r.split("\x1f").slice(0, -1));
}

const apiCallsIn = (calls, method) =>
  calls
    .map((args) => {
      const i = args.indexOf("call");
      return i >= 0 && args[i + 1] === method ? args[i + 2] ?? "" : null;
    })
    .filter((p) => p !== null);

let endpoint = null;

function rex(args, { input } = {}) {
  const head = ["--autostart=false", "--timeout", "10s", ...(endpoint ? ["-S", endpoint] : [])];
  return execFileSync("rex", [...head, ...args], { encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], timeout: 15_000 });
}

const listSessions = () => JSON.parse(rex(["ls", "--json"])).sessions ?? [];

function hive(args, { cwd, env = {}, timeoutMs = 180_000 } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: timeoutMs });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, error: r.error };
}

class Mcp {
  constructor(cwd, env) {
    this.child = spawn(process.execPath, [SERVER], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "ignore"] });
    this.next = 1;
    this.pending = new Map();
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const text = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          continue;
        }
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      }
    });
  }

  request(method, params, timeoutMs = 240_000) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async start() {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hive-live-check", version: "0" } }, 30_000);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  async call(name, args = {}) {
    const msg = await this.request("tools/call", { name, arguments: args });
    if (msg.error) throw new Error(`${name}: ${msg.error.message}`);
    const text = msg.result?.content?.[0]?.text ?? "";
    if (msg.result?.isError) throw new Error(`${name}: ${text}`);
    return text ? JSON.parse(text) : null;
  }

  kill() {
    try {
      this.child.kill("SIGKILL");
    } catch {}
  }
}

const ctx = {
  before: [],
  created: new Map(),
  kept: false,
  mcp: null,
  cleaned: false,
};

function destroyCreated() {
  const beforeIds = new Set(ctx.before.map((s) => s.session_id));
  const killed = [];
  for (const [id, label] of ctx.created) {
    if (beforeIds.has(id)) {
      note(`NOT destroying ${label} (${id}): it existed before this run`);
      continue;
    }
    if (label !== ctx.liveLabel && !label.startsWith("hive-")) {
      note(`NOT destroying ${label} (${id}): unexpected label`);
      continue;
    }
    try {
      rex(["kill", id]);
      killed.push(label);
      ctx.created.delete(id);
    } catch (err) {
      note(`could not destroy ${label} (${id}): ${String(err.stderr ?? err.message).trim()}`);
    }
  }
  return killed;
}

function killScratchTmux() {
  const socket = ctx.paths && join(ctx.paths.tmux, `tmux-${process.getuid?.() ?? 0}`, "default");
  if (!socket || !existsSync(socket)) return;
  spawnSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore", timeout: 10_000 });
  note(`killed a tmux server hive started on the scratch socket ${socket}`);
}

function cleanup() {
  if (ctx.cleaned) return;
  ctx.cleaned = true;
  ctx.mcp?.kill();
  killScratchTmux();
  if (ctx.kept) return;
  const killed = destroyCreated();
  if (killed.length > 0) note(`destroyed in cleanup: ${killed.join(", ")}`);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    console.log(`\n${signal}: cleaning up the sessions this run created`);
    cleanup();
    process.exit(130);
  });
}

const load = (rel) => import(pathToFileURL(join(DIST, rel)).href);
const mods = {};
async function loadDist() {
  const db = await load("db.js");
  db.migrate();
  await load("rexInUse.js");
  Object.assign(mods, {
    db: db.db,
    terminal: await load("terminal.js"),
    rexTerm: await load("terminal/rex.js"),
    wakeSql: await load("wakeSql.js"),
    handoff: await load("leadHandoff.js"),
  });
}

const api = (method, params) => mods.rexCli.rexApi(endpoint, method, params);
const sessionOf = (block) => mods.rexTerm.rexSessionOf(endpoint, block);

function ownedSession(block) {
  const session = sessionOf(block);
  if (!ctx.created.has(session)) throw new Error(`refusing to touch ${block}: its session ${session} was not created by this run`);
  return session;
}

function key(block, name) {
  const session = ownedSession(block);
  mods.rexCli.rexKey(endpoint, block, name, session);
}

function typeText(block, text) {
  const session = ownedSession(block);
  rex(["send", "-s", session, "-b", block, text]);
}

function rootStatus(block) {
  const reply = api("block.method", { session_id: sessionOf(block), block_id: block, method: "program_status", args: {} });
  const records = Array.isArray(reply?.records) ? reply.records : [];
  return records.find((r) => r && r.id === undefined) ?? null;
}

const isBlocked = (status) => status !== null && (status.state === "blocked" || ["permission", "question", "auth"].includes(status.kind));
const isTrustDialog = (status) => isBlocked(status) && /trust/i.test(status.msg ?? "");

async function acceptTrust(block) {
  if (FAKE_CLAUDE) return "trust dialog not checked (fake claude)";
  const seen = await until(() => {
    const status = rootStatus(block);
    return status && (isTrustDialog(status) || status.state === "idle" || status.state === "working") ? status : null;
  }, 60_000);
  if (!seen) return "no program status within 60s";
  if (!isTrustDialog(seen)) return `no trust dialog (status ${seen.state})`;
  key(block, "down");
  await sleep(400);
  key(block, "enter");
  const cleared = await until(() => !isTrustDialog(rootStatus(block)), 30_000);
  if (!cleared) throw new Error(`the trust dialog on ${block} did not clear after down, enter`);
  return "accepted the workspace-trust dialog";
}

function viewPlace(block) {
  const view = api("session.view", { session_id: sessionOf(block) });
  for (const window of view.windows ?? []) {
    for (const layer of window.layers ?? []) {
      if ((layer.blocks ?? []).some((b) => (b.block_id ?? b) === block)) return { window: window.window_id, kind: layer.kind, state: layer.state ?? "normal" };
    }
  }
  return null;
}

const describePlace = (p) => (p ? `${p.kind}/${p.state}` : "not placed");

const agentRow = (projectId, name) => mods.db.prepare("SELECT * FROM agents WHERE project_id = ? AND name = ? ORDER BY id DESC LIMIT 1").get(projectId, name);
const leadRowOf = (projectId) => mods.db.prepare("SELECT * FROM agents WHERE project_id = ? AND kind = 'lead' ORDER BY id DESC LIMIT 1").get(projectId);

function setupScratch() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "hive-live-")));
  const paths = {
    base,
    dataDir: join(base, "data"),
    proj: join(base, "proj"),
    untrusted: join(base, "untrusted"),
    bin: join(base, "bin"),
    log: join(base, "rex-calls.log"),
    probe: join(base, "probe-rex-server"),
    tmux: join(base, "tmux"),
  };
  for (const dir of [paths.dataDir, paths.proj, paths.untrusted, paths.tmux]) mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", paths.proj]);
  writeFileSync(join(paths.proj, "hive.yml"), "dashboard: false\n");
  return paths;
}

function setHiveEnv(dataDir, tmuxDir) {
  Object.assign(process.env, { TMUX_TMPDIR: tmuxDir, HIVE_DATA_DIR: dataDir, HIVE_TERMINAL: "rex", HIVE_AUTO_ATTACH: "0", HIVE_EDITOR: "true", HIVE_NO_UPDATE_CHECK: "1" });
}

function whoami() {
  const who = JSON.parse(execFileSync("rex", ["--autostart=false", "--timeout", "10s", "whoami", "--json"], { encoding: "utf8", timeout: 15_000 }));
  check(typeof who.endpoint === "string" && who.endpoint, "rex whoami printed no endpoint");
  return who;
}

function pasteBody(a, b) {
  const rows = ["hive live check: an unchunked paste. Filler follows; the instruction is at the very end.", "metacharacters: $HOME & \"double\" 'single' `tick` | ; < > \\ %s"];
  for (let i = 1; rows.join("\n").length < 20_000; i++) rows.push(`filler ${String(i).padStart(4, "0")} the quick brown fox jumps over the lazy dog`);
  rows.push(`END OF FILLER. Reply with exactly one word and nothing else: the text ${a} immediately followed by the text ${b}, with no space between them.`);
  return rows.join("\n");
}

async function mainRun() {
  const paths = setupScratch();
  ctx.paths = paths;
  ctx.liveLabel = LIVE_LABEL;
  const realRex = findOnPath("rex");
  if (!realRex) {
    console.error("rex is not on PATH");
    return 1;
  }
  installWrapper(paths.bin, paths.log, realRex);
  setHiveEnv(paths.dataDir, paths.tmux);
  console.log(`hive live Rex check: rex ${realRex}`);
  console.log(`scratch ${paths.base} (HIVE_DATA_DIR ${paths.dataDir}); every rex call is logged to ${paths.log}`);
  console.log(`opt-ins: HIVE_LIVE_SELECT=${SELECT ? 1 : 0} HIVE_LIVE_RESTART=${RESTART ? 1 : 0} HIVE_LIVE_FAKE_CLAUDE=${FAKE_CLAUDE ? 1 : 0}`);

  let who;
  try {
    who = whoami();
  } catch (err) {
    console.error(`rex whoami failed: ${String(err.stderr ?? err.message).trim()}`);
    return 1;
  }
  endpoint = who.endpoint;
  mods.rexCli = await load("rexCli.js");
  console.log(`server ${endpoint}, rex ${who.rex_version ?? "?"}, api_revision ${who.api_revision ?? "?"}`);
  ctx.before = listSessions();
  if (ctx.before.some((s) => s.label === LIVE_LABEL)) {
    console.error(`refusing: a session labelled ${LIVE_LABEL} already exists`);
    return 1;
  }
  console.log(`sessions before: ${ctx.before.length}`);

  const s = {};
  try {
    await runSteps(paths, s);
  } finally {
    if (!ctx.kept) {
      const killed = destroyCreated();
      const left = (() => {
        try {
          const ids = new Set(listSessions().map((x) => x.session_id));
          return [...ctx.created.keys()].filter((id) => ids.has(id));
        } catch {
          return ["(could not list)"];
        }
      })();
      if (s.destroyStep !== false) {
        if (left.length === 0 && killed.length > 0) line("PASS", "9 destroy the sessions this run created", killed.join(", "));
        else if (killed.length === 0 && left.length === 0) line("SKIP", "9 destroy the sessions this run created", "nothing was created");
        else line("FAIL", "9 destroy the sessions this run created", `still open: ${left.join(", ")}`);
      }
      afterDestroy();
    }
    ctx.mcp?.kill();
    killScratchTmux();
    ctx.cleaned = true;
  }
  return summary();
}

const MUTATING = /^(session\.(new_|move_|float_|set_|resize_|detach_|focus_|destroy|rename)|block\.(event|close)|client\.perform)/;

function mutationsOfPreexisting() {
  const before = new Set(ctx.before.map((x) => x.session_id));
  const hits = [];
  for (const args of readCalls(ctx.paths.log)) {
    const i = args.indexOf("call");
    if (i >= 0 && MUTATING.test(args[i + 1] ?? "")) {
      let params = {};
      try {
        params = JSON.parse(args[i + 2] ?? "{}");
      } catch {}
      if (before.has(params.session_id)) hits.push(`${args[i + 1]} ${params.session_id}`);
    }
    const verb = args.find((a) => ["send", "send-key", "kill"].includes(a));
    const session = args[args.indexOf("-s") + 1];
    if (verb && ((args.includes("-s") && before.has(session)) || (verb === "kill" && args.some((a) => before.has(a))))) hits.push(`${verb} ${args.join(" ")}`);
  }
  return hits;
}

function afterDestroy() {
  try {
    const now = listSessions();
    const nowById = new Map(now.map((x) => [x.session_id, x.label]));
    const changed = ctx.before.filter((x) => nowById.get(x.session_id) !== x.label);
    if (changed.length === 0) line("PASS", "9a your other sessions are untouched", `${ctx.before.length} before, all present with the same labels`);
    else line("FAIL", "9a your other sessions are untouched", changed.map((x) => `${x.label} (${x.session_id}) -> ${nowById.get(x.session_id) ?? "gone"}`).join("; "));
  } catch (err) {
    line("FAIL", "9a your other sessions are untouched", err.message);
  }
  const hits = mutationsOfPreexisting();
  if (hits.length === 0) line("PASS", "9b no rex call changed a session that existed before", `${readCalls(ctx.paths.log).length} calls checked`);
  else line("FAIL", "9b no rex call changed a session that existed before", hits.slice(0, 5).join(" | "));
  console.log("     Please glance at the Rex app: your own sessions, tabs and focus should be as you left them.");
}

async function runSteps(paths, s) {
  await step("1 create the session", () => {
    const reply = api("session.create", {
      label: LIVE_LABEL,
      initial_windows: [
        {
          window_label: "probe",
          layout: {
            block: {
              flavor: SHELL_FLAVOR,
              label: "hive-live/probe",
              options: { shell: "none", login: false, cwd: paths.base, command: ["/bin/sh", "-c", 'printf "%s" "$REX_SERVER" > "$1"; exec /bin/sleep 3600', "probe", paths.probe], exit: { on_completion: false } },
            },
          },
        },
      ],
    });
    check(typeof reply.session_id === "string", `session.create returned ${JSON.stringify(reply)}`);
    ctx.created.set(reply.session_id, LIVE_LABEL);
    s.liveSession = reply.session_id;
    check(listSessions().some((x) => x.session_id === reply.session_id && x.label === LIVE_LABEL), "the new session is not listed");
    return `${LIVE_LABEL} ${reply.session_id}`;
  });

  s.ok1 = !!s.liveSession;
  const lead = await step("2 hive lead --detach", async () => {
    check(hive(["init", "--no-profile"], { cwd: paths.proj }).code === 0, "hive init failed");
    const started = hive(["lead", paths.proj, "--detach"], { cwd: paths.proj });
    check(started.code === 0, `hive lead exited ${started.code}: ${started.out.trim().slice(-600)}`);
    const pane = /LEAD_PANE=(block:\S+)/.exec(started.out)?.[1];
    check(pane, `no LEAD_PANE=block:... in: ${started.out.trim().slice(-400)}`);
    await loadDist();
    s.project = mods.db.prepare("SELECT * FROM projects WHERE path = ?").get(paths.proj);
    check(s.project, "the project is not registered");
    s.lead = leadRowOf(s.project.id);
    check(s.lead?.tmux_target === pane, `lead row target ${s.lead?.tmux_target} is not ${pane}`);
    check(s.lead.tmux_socket.startsWith("rex:"), `lead row socket ${s.lead.tmux_socket} is not a rex: socket`);
    const session = sessionOf(pane);
    if (ctx.before.some((x) => x.session_id === session)) throw new Error(`the lead landed in a session that existed before this run (${session})`);
    const label = listSessions().find((x) => x.session_id === session)?.label ?? "";
    if (!ctx.created.has(session)) ctx.created.set(session, label);
    s.leadSession = session;
    s.leadWindow = viewPlace(pane)?.window ?? "";
    const trust = await acceptTrust(pane);
    return `${pane} in ${label || session}; ${trust}`;
  }, [[s.ok1, "step 1"]]);

  await step("2a socket strings match byte for byte", async () => {
    const probe = await until(() => existsSync(paths.probe) && readFileSync(paths.probe, "utf8"), 10_000, 200);
    check(probe, "the probe block never wrote REX_SERVER");
    const caller = `rex:${probe}`;
    const recorded = s.lead.tmux_socket;
    note(`callerSocket (REX_SERVER in a block): ${JSON.stringify(caller)}`);
    note(`lead row socket (from rex whoami):    ${JSON.stringify(recorded)}`);
    note(`whoami endpoint:                      ${JSON.stringify(`rex:${endpoint}`)}`);
    check(caller === recorded, "callerSocket() and the recorded socket differ");
    return "equal";
  }, [[lead, "step 2"]]);

  const workers = await step("3 spawn 2 workers", async () => {
    ctx.mcp = new Mcp(paths.proj, { HIVE_AGENT_ID: s.lead.actor_id });
    await ctx.mcp.start();
    const notes = [];
    for (const name of WORKERS) {
      const receipt = await ctx.mcp.call("agent_spawn", { name });
      check(receipt?.agent_id, `${name}: spawn receipt ${JSON.stringify(receipt)}`);
      const row = agentRow(s.project.id, name);
      check(row?.tmux_target?.startsWith("block:"), `${name}: row target ${row?.tmux_target}`);
      ownedSession(row.tmux_target);
      notes.push(`${name} ${row.tmux_target} (${await acceptTrust(row.tmux_target)})`);
    }
    return notes.join("; ");
  }, [[lead, "step 2"]]);

  await step("4 agent_send", async () => {
    const receipt = await ctx.mcp.call("agent_send", { name: WORKERS[0], text: "hive live check: a short message. No action needed; reply ok." });
    check(receipt?.sent === true, `receipt ${JSON.stringify(receipt)}`);
    return "sent";
  }, [[workers, "step 3"]]);

  const a = `LIVE${nonce(2).toUpperCase()}`;
  const b = `TAIL${nonce(3).toUpperCase()}`;
  const body = pasteBody(a, b);
  const pasted = await step("4a a 20k paste goes out as one paste event", async () => {
    const mark = readCalls(paths.log).length;
    const receipt = await ctx.mcp.call("agent_send", { name: WORKERS[0], text: body });
    check(receipt?.sent === true, `receipt ${JSON.stringify(receipt)}`);
    const events = apiCallsIn(readCalls(paths.log).slice(mark), "block.event").filter((p) => p.includes("filler 0001"));
    check(events.length === 1, `${events.length} paste events carried the filler`);
    const text = JSON.parse(events[0]).event?.payload?.text ?? "";
    check(text.includes(body), `the one paste event does not carry the whole ${body.length}-char body`);
    return `${body.length} chars in 1 block.event`;
  }, [[workers, "step 3"]]);

  await step("4b the paste reached Claude intact (it answers the tail)", async () => {
    fakeSkip("reading the reply");
    const target = agentRow(s.project.id, WORKERS[0]).tmux_target;
    const seen = await until(() => mods.terminal.capturePane(target, 400).includes(`${a}${b}`), 300_000, 2000);
    check(seen, `${a}${b} never appeared on ${WORKERS[0]}'s screen within 300s`);
    return `${a}${b} on screen`;
  }, [[pasted, "step 4a"]]);

  await step("4c a wake to the lead is delivered quietly", async () => {
    fakeSkip("the lead's SessionStart hook");
    const wake = await ctx.mcp.call("wake_set", { delay_seconds: 1, body: `hive live check: quiet wake ${nonce(3)}. No action needed.` });
    const row = await until(() => {
      const w = mods.db.prepare("SELECT * FROM wakes WHERE id = ?").get(wake.wake_id);
      return w?.delivery_method ? w : null;
    }, 120_000, 1000);
    const leadNow = leadRowOf(s.project.id);
    note(`lead claude_messaging_pane_pid ${JSON.stringify(leadNow.claude_messaging_pane_pid)} pane_pid ${JSON.stringify(leadNow.pane_pid)}`);
    check(leadNow.claude_messaging_socket !== "" && leadNow.claude_messaging_pane_pid === leadNow.pane_pid, "the lead's messaging socket is not registered for its current pane");
    check(row, `wake #${wake.wake_id} was not delivered within 120s`);
    check(row.delivery_method === mods.wakeSql.DELIVERY_METHOD.socket, `wake #${wake.wake_id} delivery_method ${row.delivery_method}`);
    return `wake #${wake.wake_id} delivered by ${row.delivery_method}`;
  }, [[workers, "step 3"]]);

  await step("5 hide, peek and show", () => {
    const name = WORKERS[1];
    const target = agentRow(s.project.id, name).tmux_target;
    const leadWindow = viewPlace(s.lead.tmux_target)?.window;
    const run = (verb, expectKind, expectState) => {
      const r = hive([verb, name], { cwd: paths.proj });
      check(r.code === 0, `hive ${verb} exited ${r.code}: ${r.out.trim()}`);
      const place = viewPlace(target);
      check(place?.kind === expectKind && place.state === expectState && place.window === leadWindow, `after ${verb}: ${describePlace(place)} in ${place?.window}, wanted ${expectKind}/${expectState} in the lead's tab`);
      return `${verb} ${describePlace(place)}`;
    };
    return [run("hide", "floating", "minimized"), run("peek", "floating", "normal"), run("hide", "floating", "minimized"), run("show", "tiled", "normal")].join(", ");
  }, [[workers, "step 3"]]);

  const selectCalls = () => apiCallsIn(readCalls(paths.log), "client.perform").filter((p) => p.includes("session.select"));
  await step("5a hive sent no session.select", () => {
    const found = selectCalls();
    check(found.length === 0, `${found.length} client.perform session.select call(s): ${found.join(" | ")}`);
    return `${readCalls(paths.log).length} rex calls so far, none select a session`;
  }, [[workers, "step 3"]]);

  await step("5b client.perform session.select (HIVE_LIVE_SELECT)", () => {
    if (!SELECT) skip("off; set HIVE_LIVE_SELECT=1 to switch the Rex app's view");
    const clients = (api("client.list", { kinds: ["app"] }).clients ?? []).filter((c) => c.client_id && c.connection_state !== "lost");
    check(clients.length > 0, "no app client is connected");
    const reply = api("client.perform", { client_id: clients[0].client_id, action: "session.select", args: { session_id: s.leadSession, window_id: s.leadWindow }, origin: "cli", timeout_ms: 5000 });
    note(`reply: ${JSON.stringify(reply)}`);
    return `performed by ${clients[0].client_id}`;
  }, [[lead, "step 2"]]);

  await step("6 a handoff", async () => {
    fakeSkip("the lead's own Stop hooks confirming the successor");
    const old = leadRowOf(s.project.id);
    const content = mods.handoff.HANDOFF_HEADINGS.map((h) => `${h}\nnone: this is the hive live Rex check`).join("\n\n");
    const pad = await ctx.mcp.call("pad_write", { name: mods.handoff.HANDOFF_PAD_NAME, content });
    const idle = await until(() => rootStatus(old.tmux_target)?.state === "idle", 300_000, 2000);
    check(idle, "the lead never went idle within 300s");
    typeText(old.tmux_target, "!");
    await sleep(800);
    typeText(old.tmux_target, `${q(process.execPath)} ${q(CLI)} lead-handoff --pad ${pad.pad_id} --revision ${pad.revision}`);
    await sleep(500);
    key(old.tmux_target, "enter");
    const settled = await until(() => {
      const h = mods.db.prepare("SELECT * FROM lead_handoffs WHERE lead_agent_id = ? ORDER BY id DESC LIMIT 1").get(old.id);
      return h && ["completed", "failed", "ambiguous"].includes(h.state) ? h : null;
    }, 600_000, 2000);
    const latest = mods.db.prepare("SELECT * FROM lead_handoffs WHERE lead_agent_id = ? ORDER BY id DESC LIMIT 1").get(old.id);
    check(settled, `the handoff did not settle within 600s (state ${latest?.state ?? "none: lead-handoff never armed"})`);
    check(settled.state === "completed", `handoff #${settled.id} ${settled.state}: ${settled.failure ?? ""}`);
    const now = leadRowOf(s.project.id);
    check(now.tmux_target !== old.tmux_target, "the lead row still names the old block");
    ownedSession(now.tmux_target);
    s.lead = now;
    let oldOpen = true;
    try {
      sessionOf(old.tmux_target);
    } catch {
      oldOpen = false;
    }
    check(!oldOpen, `the old lead block ${old.tmux_target} is still open`);
    check(viewPlace(now.tmux_target)?.window === s.leadWindow, "the successor is not in the lead's tab");
    return `handoff #${settled.id} completed: ${old.tmux_target} -> ${now.tmux_target}`;
  }, [[workers, "step 3"]]);

  await step("7 a status hold on a worker at the trust dialog", async () => {
    const receipt = await ctx.mcp.call("agent_spawn", { name: HOLD_WORKER, cwd: paths.untrusted });
    check(receipt?.agent_id, `spawn receipt ${JSON.stringify(receipt)}`);
    const target = agentRow(s.project.id, HOLD_WORKER).tmux_target;
    ownedSession(target);
    const blocked = await until(() => {
      const status = rootStatus(target);
      const dialog = mods.terminal.paneAwaitingChoice(target);
      return isBlocked(status) || dialog ? { status, dialog } : null;
    }, 90_000, 1000);
    check(blocked, "the worker never showed a blocked status or a dialog within 90s");
    if (!FAKE_CLAUDE) check(isBlocked(blocked.status), `Claude did not report a blocked program status: ${JSON.stringify(blocked.status)}`);
    const sent = await ctx.mcp.call("agent_send", { name: HOLD_WORKER, text: "hive live check: this must be refused" });
    check(sent?.sent === false && /waiting on a choice/.test(sent.note ?? ""), `agent_send was not refused: ${JSON.stringify(sent)}`);
    const wake = await ctx.mcp.call("wake_set", { delay_seconds: 1, deliver_to: HOLD_WORKER, body: "hive live check: this wake must be held" });
    const held = await until(() => {
      const w = mods.db.prepare("SELECT * FROM wakes WHERE id = ?").get(wake.wake_id);
      return w?.held_reason === mods.wakeSql.HELD_REASON_MODAL_CHOICE && !w.typed_at ? w : null;
    }, 60_000, 1000);
    await ctx.mcp.call("wake_cancel", { wake_id: wake.wake_id }).catch(() => {});
    check(held, `wake #${wake.wake_id} was not held with the modal-choice reason within 60s`);
    const why = blocked.status ? `program status ${blocked.status.state}/${blocked.status.kind ?? "-"} "${blocked.status.msg ?? ""}"` : "no program status (fake claude), screen dialog only";
    return `send refused, wake #${wake.wake_id} held; ${why}; screen dialog ${blocked.dialog}`;
  }, [[workers, "step 3"]]);

  await step("8 hive doctor", () => {
    const r = hive(["doctor"], { cwd: paths.proj });
    check(r.code !== null, `hive doctor did not finish: ${r.error?.message ?? ""}`);
    const rows = r.out.split("\n").filter((l) => /^\s*(ok|warn|info|FAIL)\s+(rex|terminal|config terminal)\b/.test(l));
    for (const row of rows) note(row.trim());
    check(rows.some((l) => /terminal: "?rex/.test(l)), "doctor did not report the rex terminal");
    const bad = rows.filter((l) => /^\s*FAIL\b/.test(l));
    check(bad.length === 0, `doctor reported Rex problems: ${bad.join(" | ")}`);
    return `exit ${r.code}, ${rows.length} Rex line(s)`;
  }, [[lead, "step 2"]]);

  if (RESTART && results.every((r) => r.status !== "FAIL")) {
    ctx.kept = true;
    s.destroyStep = false;
    const rows = mods.db.prepare("SELECT id, name, kind, tmux_target FROM agents WHERE project_id = ? AND status = 'running'").all(s.project.id);
    writeFileSync(RESTART_STATE, JSON.stringify({ paths, endpoint, before: ctx.before, created: [...ctx.created], liveLabel: LIVE_LABEL, projectId: s.project.id, rows }, null, 2));
    line("SKIP", "9 destroy the sessions this run created", "kept for HIVE_LIVE_RESTART");
    console.log(`
Restart phase armed; state in ${RESTART_STATE}. Do NOT expect this script to edit init.lua.
  1. Install hive's resume trust rule by hand: run \`hive setup --rex-resume\` and add the rule it prints to your init.lua.
  2. Run \`rex server stop\`. This kills EVERY session's programs, this terminal included.
  3. Reopen Rex, then run:
       HIVE_TEST_LIVE_REX=1 HIVE_LIVE_RESTART=1 node ${join(REPO, "scripts", "rex-live-check.mjs")} --restart-verify`);
  } else if (RESTART) {
    note("HIVE_LIVE_RESTART is set but a step failed, so the restart phase is not armed");
  }
}

async function restartVerify() {
  if (!existsSync(RESTART_STATE)) {
    console.error(`no restart state at ${RESTART_STATE}; run once with HIVE_LIVE_RESTART=1 first`);
    return 1;
  }
  const state = JSON.parse(readFileSync(RESTART_STATE, "utf8"));
  ctx.paths = state.paths;
  ctx.liveLabel = state.liveLabel;
  ctx.before = state.before;
  ctx.created = new Map(state.created);
  const realRex = findOnPath("rex");
  if (!realRex) {
    console.error("rex is not on PATH");
    return 1;
  }
  installWrapper(state.paths.bin, state.paths.log, realRex);
  setHiveEnv(state.paths.dataDir, state.paths.tmux);
  endpoint = state.endpoint;
  mods.rexCli = await load("rexCli.js");
  try {
    await step("R1 the Rex server answers", () => {
      const who = whoami();
      check(who.endpoint === state.endpoint, `whoami endpoint ${who.endpoint} is not ${state.endpoint}`);
      return `${who.endpoint}, rex ${who.rex_version ?? "?"}`;
    });
    await loadDist();
    await step("R2 the sessions came back", () => {
      const ids = new Set(listSessions().map((x) => x.session_id));
      const missing = [...ctx.created].filter(([id]) => !ids.has(id));
      check(missing.length === 0, `missing: ${missing.map(([id, label]) => `${label} ${id}`).join(", ")}`);
      return [...ctx.created.values()].join(", ");
    });
    await step("R3 every running row is live again with its identity", async () => {
      const states = [];
      for (const recorded of state.rows) {
        const live = await until(() => {
          const row = mods.db.prepare("SELECT * FROM agents WHERE id = ?").get(recorded.id);
          const owned = row ? mods.terminal.rowOwnership(row) : "missing";
          return owned === "live" ? owned : null;
        }, 180_000, 3000);
        const row = mods.db.prepare("SELECT * FROM agents WHERE id = ?").get(recorded.id);
        states.push(`${recorded.name} ${live ?? mods.terminal.rowOwnership(row)}${row.tmux_target === recorded.tmux_target ? "" : ` (now ${row.tmux_target})`}`);
      }
      check(states.every((x) => / live/.test(x)), states.join("; "));
      return states.join("; ");
    });
    const status = hive(["status"], { cwd: state.paths.proj });
    for (const row of status.out.split("\n").slice(0, 30)) note(row);
  } finally {
    const killed = destroyCreated();
    line(ctx.created.size === 0 ? "PASS" : "FAIL", "R4 destroy the sessions this run created", killed.join(", ") || "none");
    afterDestroy();
    ctx.cleaned = true;
    if (ctx.created.size === 0) rmSync(RESTART_STATE, { force: true });
  }
  return summary();
}

function summary() {
  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("SKIP")} SKIP`);
  if (ctx.paths) console.log(`rex call log: ${ctx.paths.log} (${readCalls(ctx.paths.log).length} calls)`);
  return count("FAIL") > 0 ? 1 : 0;
}

const code = await (RESTART_VERIFY ? restartVerify() : mainRun()).catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  cleanup();
  return 1;
});
process.exit(code);
