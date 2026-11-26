import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { REPO } from "./helpers.mjs";
import { FAKE_REX_DIR, fakeRexDo, isolateRex, rexCallScanViolations, waitFor } from "./rex-helpers.mjs";

const tmp = mkdtempSync(join(tmpdir(), "hive-rex-cli-"));
const fake = isolateRex(tmp);
const REX_ADDR = fake.env.REX_SERVER;
const SHELL = "com.superlogical.terminal.shell";
const NO_SERVER_MESSAGE = (url) => `Error: no Rex server is running at ${url.replace(/^unix:\/\//, "")}, and autostart is disabled`;

const cli = () => import("../dist/rexCli.js");

const realCalls = () => fake.calls().filter((c) => c.argv[0] !== "__fake");

function withEnvVars(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function newBlock(command, label = "b") {
  const { rexApi } = await cli();
  const made = rexApi(REX_ADDR, "session.create", {
    label: `s-${label}-${Date.now()}`,
    initial_windows: [{ window_label: label, layout: { block: { flavor: SHELL, label, options: { shell: "none", login: false, command } } } }],
  });
  return { session: made.session_id, window: made.initial_windows[0].window_id, block: made.initial_windows[0].block_ids[0] };
}

const screenOf = async (b) =>
  (await cli()).rexApi(REX_ADDR, "block.method", { session_id: b.session, block_id: b.block, method: "format", args: { format: "text" } }).content;

function verbOf(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--timeout" || argv[i] === "-S") i++;
    else if (!argv[i].startsWith("-")) return argv[i];
  }
  return null;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const BLOCK_CHILD = (dir, ownerPid, hold) => `const { isolateRex } = await import(${JSON.stringify(join(REPO, "test", "rex-helpers.mjs"))});
const { execFileSync } = await import("node:child_process");
const f = isolateRex(${JSON.stringify(dir)}${ownerPid ? `, { ownerPid: ${ownerPid} }` : ""});
const bin = "rex";
execFileSync(bin, ["--autostart=false", "--timeout", "10s", "-S", f.env.REX_SERVER, "api", "call", "session.create",
  JSON.stringify({ initial_windows: [{ layout: { block: { flavor: "com.superlogical.terminal.shell", options: { command: ["sleep", "60"] } } } }] })]);
console.log(JSON.stringify({ relays: f.state().relays }));
${hold ? "setInterval(() => {}, 1 << 30);" : ""}`;

function runBlockChild(dir, { ownerPid } = {}) {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", BLOCK_CHILD(dir, ownerPid, false)], { encoding: "utf8" });
  return JSON.parse(out);
}

function spawnBlockChild(dir, { ownerPid } = {}) {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", BLOCK_CHILD(dir, ownerPid, true)], { stdio: ["ignore", "pipe", "inherit"] });
  const ready = new Promise((resolve, reject) => {
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) resolve(JSON.parse(buf.split("\n")[0]));
    });
    proc.once("exit", (code) => reject(new Error(`block child exited early with ${code}`)));
  });
  return { proc, ready };
}

function runDefaultServerChild(env) {
  const src = `const m = await import(${JSON.stringify(join(REPO, "dist", "rexCli.js"))});\nconsole.log(JSON.stringify([m.defaultRexServer(), m.defaultRexServer()]));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", src], { env, encoding: "utf8" });
  return JSON.parse(out);
}

describe("rex CLI wrapper", () => {
  it("every rex invocation carries --autostart=false and --timeout 10s", async () => {
    const { rexApi, rexKey, rexLua, SNAPSHOT_SCRIPT, REX_TIMEOUT } = await cli();
    assert.equal(REX_TIMEOUT, "10s");
    const before = realCalls().length;
    const b = await newBlock(["cat"], "flags");
    rexApi(REX_ADDR, "session.list", {});
    rexKey(REX_ADDR, b.block, "enter");
    rexLua(REX_ADDR, SNAPSHOT_SCRIPT);
    const env = { ...fake.env };
    delete env.REX_SERVER;
    runDefaultServerChild(env);
    const calls = realCalls().slice(before);
    const verbs = new Set(calls.map((c) => verbOf(c.argv)));
    for (const verb of ["api", "send-key", "do", "whoami"]) assert.ok(verbs.has(verb), `${verb} was invoked: ${[...verbs]}`);
    for (const { argv } of calls) {
      assert.ok(argv.includes("--autostart=false"), argv.join(" "));
      assert.equal(argv[argv.indexOf("--timeout") + 1], "10s", argv.join(" "));
      if (!argv.includes("whoami")) assert.equal(argv[argv.indexOf("-S") + 1], REX_ADDR, argv.join(" "));
    }
  });

  it("a stopped server raises RexUnavailableError, a hung one RexTimeoutError", async () => {
    const { rexApi, RexUnavailableError, RexTimeoutError, RexError } = await cli();
    fakeRexDo(tmp, "stopServer");
    try {
      assert.throws(
        () => rexApi(REX_ADDR, "session.list", {}),
        (e) => e instanceof RexUnavailableError && e.code === "unreachable" && e.stderr === NO_SERVER_MESSAGE(REX_ADDR),
      );
    } finally {
      fakeRexDo(tmp, "restartServer");
    }
    assert.ok(Array.isArray(rexApi(REX_ADDR, "session.list", {}).sessions));

    const started = Date.now();
    const before = fake.calls().length;
    withEnvVars({ FAKE_REX_HANG: "1", HIVE_REX_TIMEOUT: "1s" }, () => {
      assert.throws(
        () => rexApi(REX_ADDR, "session.list", {}),
        (e) => e instanceof RexTimeoutError && e instanceof RexError && !(e instanceof RexUnavailableError),
      );
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1000 && elapsed < 6000, `killed after ${elapsed}ms`);
    const hung = fake.calls().slice(before);
    assert.equal(hung.length, 1);
    assert.equal(hung[0].argv[hung[0].argv.indexOf("--timeout") + 1], "1000ms");
    assert.equal(alive(hung[0].pid), false, "the hung rex process was killed");
  });

  it("a rex that fails only after its --timeout has elapsed is a RexTimeoutError, not a plain failure", async () => {
    const { rexApi, RexTimeoutError } = await cli();
    const started = Date.now();
    withEnvVars({ FAKE_REX_SLOW_EXIT1: "1", HIVE_REX_TIMEOUT: "1s" }, () => {
      assert.throws(() => rexApi(REX_ADDR, "session.list", {}), (e) => e instanceof RexTimeoutError && e.timeoutMs === 1000 && /fake slow failure/.test(e.stderr));
    });
    assert.ok(Date.now() - started < 3000, "classified from rex's own exit, before the kill bound");
  });

  it("a rex killed by a signal is a RexError naming the signal, never a timeout", async () => {
    const { rexApi, RexError, RexTimeoutError } = await cli();
    withEnvVars({ FAKE_REX_SELF_KILL: "SIGTERM" }, () => {
      assert.throws(() => rexApi(REX_ADDR, "session.list", {}), (e) => e instanceof RexError && !(e instanceof RexTimeoutError) && e.code === "signal SIGTERM");
    });
  });

  it("HIVE_REX_TIMEOUT is rounded up to whole milliseconds and clamped to 60s; junk falls back to 10s", async () => {
    const { rexTimeout } = await cli();
    const cases = { "1.5ms": "2ms", "2s": "2000ms", "1000h": "60000ms", "0s": "10s", banana: "10s", "-1s": "10s" };
    for (const [raw, want] of Object.entries(cases)) assert.equal(withEnvVars({ HIVE_REX_TIMEOUT: raw }, rexTimeout), want, raw);
    assert.equal(withEnvVars({ HIVE_REX_TIMEOUT: undefined }, rexTimeout), "10s");
  });

  it("under the test runner rexRun refuses without FAKE_REX_STATE, before spawning anything", async () => {
    const { rexApi, RexError } = await cli();
    assert.ok(process.env.NODE_TEST_CONTEXT, "this file runs under node --test");
    const before = fake.calls().length;
    withEnvVars({ FAKE_REX_STATE: undefined }, () => {
      assert.throws(() => rexApi(REX_ADDR, "session.list", {}), (e) => e instanceof RexError && e.code === "test-isolation");
    });
    assert.equal(fake.calls().length, before);
  });

  it("a missing rex binary raises RexUnavailableError with code ENOENT", async () => {
    const { rexApi, RexUnavailableError } = await cli();
    const empty = mkdtempSync(join(tmp, "nopath-"));
    withEnvVars({ PATH: empty }, () => {
      assert.throws(() => rexApi(REX_ADDR, "session.list", {}), (e) => e instanceof RexUnavailableError && e.code === "ENOENT");
    });
  });

  it("a server address the fake does not serve is unavailable, so -S really selects the server", async () => {
    const { rexApi, RexUnavailableError } = await cli();
    assert.throws(() => rexApi(`unix://${tmp}/other.sock`, "session.list", {}), (e) => e instanceof RexUnavailableError);
    assert.ok(Array.isArray(rexApi(REX_ADDR, "session.list", {}).sessions));
  });

  it("a server-side error surfaces as RexError carrying the API error code", async () => {
    const { rexApi, RexError, RexUnavailableError } = await cli();
    assert.throws(
      () => rexApi(REX_ADDR, "session.view", { session_id: "session:00000000-0000-0000-0000-000000000000" }),
      (e) => e instanceof RexError && !(e instanceof RexUnavailableError) && e.code === "session_not_found",
    );
  });

  it("rexApi passes JSON params as one argv element", async () => {
    const { rexApi } = await cli();
    const b = await newBlock(["cat"], "json");
    const params = { session_id: b.session, block_id: b.block, event: { type: "paste", payload: { text: 'a b $X "q"' } } };
    const before = realCalls().length;
    rexApi(REX_ADDR, "block.event", params);
    const [call] = realCalls().slice(before);
    assert.equal(call.argv.at(-1), JSON.stringify(params));
    assert.equal(call.argv.at(-2), "block.event");
    const recorded = fake.state().blocks[b.block].events.filter((e) => e.type === "paste");
    assert.deepEqual(recorded.map((e) => e.payload.text), ['a b $X "q"']);
  });

  it("params over 64 KiB travel on stdin as -, not argv, and arrive intact", async () => {
    const { rexApi } = await cli();
    const b = await newBlock(["sleep", "30"], "big");
    const text = "x".repeat(200 * 1024);
    const before = realCalls().length;
    rexApi(REX_ADDR, "block.event", { session_id: b.session, block_id: b.block, event: { type: "paste", payload: { text } } });
    const [call] = realCalls().slice(before);
    assert.deepEqual(call.argv.slice(-3), ["call", "block.event", "-"]);
    const pasted = fake.state().blocks[b.block].events.filter((e) => e.type === "paste");
    assert.equal(pasted.length, 1);
    assert.equal(pasted[0].payload.text, text);
  });

  it("rexLua runs do -e with --json and returns the parsed snapshot naming each block's pid", async () => {
    const { rexLua, SNAPSHOT_SCRIPT } = await cli();
    assert.equal(SNAPSHOT_SCRIPT.split("\n")[0], "-- hive:snapshot v1");
    const b = await newBlock(["sleep", "30"], "snap");
    const other = await newBlock(["sleep", "30"], "snap-other");
    const before = realCalls().length;
    const snap = rexLua(REX_ADDR, SNAPSHOT_SCRIPT, { blocks: [b.block] });
    const [call] = realCalls().slice(before);
    assert.deepEqual(call.argv.slice(-6), ["do", "-e", SNAPSHOT_SCRIPT, "--json", "--args", JSON.stringify({ blocks: [b.block] })]);
    const entry = snap.blocks[b.block];
    assert.equal(entry.session_id, b.session);
    assert.equal(entry.probed, true);
    assert.equal(entry.process.child.pid, fake.state().blocks[b.block].child_pid);
    assert.deepEqual(entry.program_status.records, {}, "an empty Lua table encodes as an object, as on real Rex");
    assert.equal(snap.blocks[other.block].probed, false, "a block hive did not ask about is listed but not probed");
    assert.equal(snap.blocks[other.block].process, undefined);
  });

  it("the snapshot script attaches each session before listing it, so blocks in every session are probed", async () => {
    const { rexLua, SNAPSHOT_SCRIPT } = await cli();
    const a = await newBlock(["sleep", "30"], "attach-a");
    const b = await newBlock(["sleep", "30"], "attach-b");
    const snap = rexLua(REX_ADDR, SNAPSHOT_SCRIPT, { blocks: [a.block, b.block] });
    assert.equal(snap.incomplete, false);
    assert.equal(snap.blocks[a.block].probed, true);
    assert.equal(snap.blocks[b.block].probed, true);
  });

  it("without the per-session attach the fake, like real Rex, lists only the caller's session and reports incomplete", async () => {
    const { rexLua, SNAPSHOT_SCRIPT } = await cli();
    const a = await newBlock(["sleep", "30"], "unattached");
    const unattached = SNAPSHOT_SCRIPT.replace(/^.*rex\.session\.attach.*$/m, "  local attach_err = nil");
    assert.notEqual(unattached, SNAPSHOT_SCRIPT, "the attach line was removed");
    const snap = rexLua(REX_ADDR, unattached, { blocks: [a.block] });
    assert.equal(snap.incomplete, true);
    assert.equal(snap.blocks[a.block], undefined);
  });

  it("an exited block's process has last_exit and no child, as on real Rex", async () => {
    const { rexApi, rexLua, SNAPSHOT_SCRIPT } = await cli();
    const b = await newBlock(["/bin/sh", "-c", "exit 3"], "exited-shape");
    await waitFor(() => rexApi(REX_ADDR, "block.method", { session_id: b.session, block_id: b.block, method: "process", args: {} }).last_exit);
    const proc = rexLua(REX_ADDR, SNAPSHOT_SCRIPT, { blocks: [b.block] }).blocks[b.block].process;
    assert.deepEqual(Object.keys(proc).sort(), ["home", "last_exit"]);
    assert.equal(proc.last_exit.exit_code, 3);
  });

  it("rexLua refuses any script but the hive snapshot on the fake", async () => {
    const { rexLua, RexError } = await cli();
    assert.throws(() => rexLua(REX_ADDR, 'return rex.call("session.list")'), RexError);
  });

  it("rexKey sends one named key to one block through send-key -b", async () => {
    const { rexKey } = await cli();
    const b = await newBlock(["cat"], "key");
    const before = realCalls().length;
    rexKey(REX_ADDR, b.block, "ctrl+c");
    const [call] = realCalls().slice(before);
    assert.deepEqual(call.argv.slice(-4), ["send-key", "-b", b.block, "ctrl+c"]);
    assert.deepEqual(fake.state().blocks[b.block].events.map((e) => e.payload.key), ["ctrl+c"]);
  });

  it("defaultRexServer returns REX_SERVER when set without running rex", async () => {
    const { defaultRexServer } = await cli();
    const before = realCalls().length;
    assert.equal(defaultRexServer(), REX_ADDR);
    assert.equal(realCalls().length, before);
  });

  it("defaultRexServer asks whoami once per process when REX_SERVER is unset", () => {
    const env = { ...fake.env };
    delete env.REX_SERVER;
    const before = realCalls().filter((c) => c.argv.includes("whoami")).length;
    assert.deepEqual(runDefaultServerChild(env), [REX_ADDR, REX_ADDR]);
    assert.equal(realCalls().filter((c) => c.argv.includes("whoami")).length - before, 1);
  });

  it("defaultRexServer is null, never a throw, when rex is missing or the server is down", () => {
    const env = { ...fake.env, PATH: mkdtempSync(join(tmp, "nopath-")) };
    delete env.REX_SERVER;
    assert.deepEqual(runDefaultServerChild(env), [null, null]);
    fakeRexDo(tmp, "stopServer");
    try {
      const down = { ...fake.env };
      delete down.REX_SERVER;
      const before = realCalls().filter((c) => c.argv.includes("whoami")).length;
      assert.deepEqual(runDefaultServerChild(down), [null, null]);
      assert.equal(realCalls().filter((c) => c.argv.includes("whoami")).length - before, 1, "the failure is cached, not retried");
    } finally {
      fakeRexDo(tmp, "restartServer");
    }
  });
});

describe("fake rex", () => {
  it("runs a block's command as a real process whose stdin is fed by pastes", async () => {
    const { rexApi } = await cli();
    const b = await newBlock(["cat"], "echo");
    rexApi(REX_ADDR, "block.event", { session_id: b.session, block_id: b.block, event: { type: "paste", payload: { text: "hello fake" } } });
    rexApi(REX_ADDR, "block.event", { session_id: b.session, block_id: b.block, event: { type: "key", payload: { key: "enter" } } });
    await waitFor(async () => (await screenOf(b)).includes("hello fake"));
    const proc = rexApi(REX_ADDR, "block.method", { session_id: b.session, block_id: b.block, method: "process" });
    assert.ok(alive(proc.child.pid));
    assert.equal(proc.last_exit, null);
  });

  it("closeBlock kills the block's process and the block stops resolving", async () => {
    const { rexApi } = await cli();
    const b = await newBlock(["sleep", "30"], "close");
    const pid = fake.state().blocks[b.block].child_pid;
    assert.ok(alive(pid));
    fakeRexDo(tmp, "closeBlock", { block_id: b.block });
    await waitFor(() => !alive(pid));
    const res = rexApi(REX_ADDR, "target.resolve", { kinds: ["block"], queries: [b.block] });
    assert.equal(res.results[0].status, "not_found");
  });

  it("transferWindow moves a block to another session, and target.resolve finds it there", async () => {
    const { rexApi } = await cli();
    const b = await newBlock(["sleep", "30"], "move");
    fakeRexDo(tmp, "transferWindow", { window_id: b.window, session_label: "elsewhere" });
    const res = rexApi(REX_ADDR, "target.resolve", { kinds: ["block"], queries: [b.block] });
    assert.equal(res.results[0].status, "resolved");
    assert.notEqual(res.results[0].target.session_id, b.session);
    const label = rexApi(REX_ADDR, "session.view", { session_id: res.results[0].target.session_id }).label;
    assert.equal(label, "elsewhere");
  });

  it("a block's children carry the fake's REX_SERVER and their own REX_BLOCK, never the caller's", async () => {
    const leaks = { REX_SESSION: "leaked-session", OSC7577_TOKEN: "leaked-token", REX_CLIENT: "leaked-client" };
    Object.assign(process.env, leaks);
    let block;
    try {
      block = await newBlock(["env"], "env");
    } finally {
      for (const k of Object.keys(leaks)) delete process.env[k];
    }
    await waitFor(async () => (await screenOf(block)).includes("PATH="));
    const lines = (await screenOf(block)).split("\n");
    assert.deepEqual(lines.filter((l) => l.includes("leaked")), []);
    assert.ok(lines.includes(`REX_BLOCK=${block.block}`));
    assert.ok(lines.includes(`REX_SERVER=${REX_ADDR}`));
  });

  it("isolateRex's exit cleanup kills every block process the file started, with the owner watch out of play", async () => {
    const { relays } = await runBlockChild(mkdtempSync(join(tmp, "child-")), { ownerPid: process.pid });
    assert.equal(relays.length, 1);
    await waitFor(() => relays.every((r) => !alive(r.child_pid) && !alive(r.relay_pid)));
  });

  it("a test process killed by SIGTERM takes its relays with it, through the relay's owner watch", async () => {
    const child = spawnBlockChild(mkdtempSync(join(tmp, "sigterm-")));
    const { relays } = await child.ready;
    assert.ok(relays.every((r) => alive(r.relay_pid) && alive(r.child_pid)));
    child.proc.kill("SIGTERM");
    await waitFor(() => relays.every((r) => !alive(r.child_pid) && !alive(r.relay_pid)), { timeoutMs: 4000 });
  });

  it("the runner's relay check reports and kills a relay whose owner is still alive", async () => {
    const { checkRelayLeaks, describeRelayLeaks } = await import("../scripts/rex-relay-leaks.mjs");
    const dir = mkdtempSync(join(tmp, "leak-"));
    const child = spawnBlockChild(dir, { ownerPid: process.pid });
    const { relays } = await child.ready;
    child.proc.kill("SIGKILL");
    await new Promise((r) => child.proc.once("exit", r));
    assert.ok(relays.every((r) => alive(r.relay_pid)), "the relay survived its SIGKILLed test process");
    const manifest = join(dir, "manifest");
    writeFileSync(manifest, `${join(dir, "fake-rex.json")}\n`);
    const result = checkRelayLeaks(manifest, { settleMs: 0 });
    assert.deepEqual(result.leaked.map((r) => r.relay_pid), relays.map((r) => r.relay_pid));
    assert.match(describeRelayLeaks(result)[0], /^1 fake rex relay\(s\) outlived/);
    await waitFor(() => relays.every((r) => !alive(r.relay_pid) && !alive(r.child_pid)));
    assert.deepEqual(checkRelayLeaks(manifest, { settleMs: 0 }).leaked, []);
  });

  it("cleanup signals only pids that are still this fake's relays, and a closed block's relay is forgotten", async () => {
    const { liveRelays } = await import("../scripts/rex-relay-leaks.mjs");
    const b = await newBlock(["sleep", "30"], "forget");
    const relayPid = fake.state().blocks[b.block].relay_pid;
    assert.ok(fake.state().relays.some((r) => r.relay_pid === relayPid));
    fakeRexDo(tmp, "closeBlock", { block_id: b.block });
    assert.equal(fake.state().relays.some((r) => r.relay_pid === relayPid), false);
    const planted = join(mkdtempSync(join(tmp, "planted-")), "state.json");
    writeFileSync(planted, JSON.stringify({ relays: [{ relay_pid: process.pid, child_pid: 0, block_id: "block:x" }] }));
    assert.deepEqual(liveRelays(planted), []);
  });

  it("isolateRex strips REX_BLOCK, REX_SESSION and OSC7577_TOKEN that were planted before it ran", () => {
    const helpers = join(REPO, "test", "rex-helpers.mjs");
    const dir = mkdtempSync(join(tmp, "strip-"));
    const src = `const { isolateRex } = await import(${JSON.stringify(helpers)});
const f = isolateRex(${JSON.stringify(dir)});
const keys = ["REX_BLOCK", "REX_SESSION", "OSC7577_TOKEN", "REX_CLIENT"];
console.log(JSON.stringify({ env: keys.map((k) => process.env[k] ?? null), returned: keys.map((k) => f.env[k] ?? null), server: f.env.REX_SERVER }));`;
    const planted = { ...process.env, REX_BLOCK: "planted-block", REX_SESSION: "planted-session", OSC7577_TOKEN: "planted-token", REX_CLIENT: "planted-client", REX_SERVER: "unix:///planted.sock" };
    const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", src], { env: planted, encoding: "utf8" }));
    assert.deepEqual(out.env, [null, null, null, null]);
    assert.deepEqual(out.returned, [null, null, null, null]);
    assert.equal(out.server, `unix://${dir}/fake-rex.sock`);
  });

  it("the state lock waits for a live holder and is stolen only from a dead one", async () => {
    const { rexApi } = await cli();
    const lock = join(tmp, "fake-rex.json.lock");
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    assert.equal(alive(dead), false);
    writeFileSync(lock, String(dead));
    assert.ok(Array.isArray(rexApi(REX_ADDR, "session.list", {}).sessions), "a dead holder's lock is stolen");
    writeFileSync(lock, String(process.pid));
    const bin = "rex";
    const waiting = spawn(bin, ["--autostart=false", "--timeout", "10s", "-S", REX_ADDR, "api", "call", "session.list"], { env: fake.env, stdio: "ignore" });
    const exited = new Promise((r) => waiting.once("exit", r));
    const early = await Promise.race([exited.then(() => "exited"), new Promise((r) => setTimeout(() => r("waiting"), 6000))]);
    assert.equal(early, "waiting", "a live holder's lock is not stolen, even after 5s");
    rmSync(lock, { force: true });
    assert.equal(await exited, 0);
  });

  it("stopServer fails every call with real rex's exit 4 and no-server message until restartServer", () => {
    fakeRexDo(tmp, "stopServer");
    try {
      const bin = "rex";
      const r = spawnSync(bin, ["--autostart=false", "--timeout", "10s", "-S", REX_ADDR, "api", "call", "session.list"], { env: fake.env, encoding: "utf8" });
      assert.equal(r.status, 4);
      assert.equal(r.stderr, `${NO_SERVER_MESSAGE(REX_ADDR)}\n`);
    } finally {
      fakeRexDo(tmp, "restartServer");
    }
  });

  it("the fake refuses a call that omits --autostart=false", () => {
    const bin = "rex";
    const r = spawnSync(bin, ["--timeout", "10s", "-S", REX_ADDR, "api", "call", "session.list"], { env: fake.env, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /autostart/);
  });
});

describe("real rex shapes the fake mirrors", () => {
  const WHOAMI_KEYS = [
    "principal", "account", "endpoint", "pid", "instance_id", "host_id", "started_at", "rex_version", "api_revision",
    "exit_empty", "session_count", "log_path", "tailscale", "session_id", "window_id", "block_id",
  ];

  it("the fake's whoami --json has real rex's top-level keys, with the server URL in endpoint", () => {
    const out = execFileSync("/bin/sh", ["-c", "rex --autostart=false --timeout 10s whoami --json"], { env: fake.env, encoding: "utf8" });
    const who = JSON.parse(out);
    assert.deepEqual(Object.keys(who).sort(), [...WHOAMI_KEYS].sort());
    assert.deepEqual(Object.keys(who.principal).sort(), ["display", "gid", "kind", "pid", "transport", "uid"]);
    assert.equal(who.endpoint, REX_ADDR);
  });

  it("every .vt fixture the rex fixture README lists exists and is non-empty", () => {
    const dir = join(REPO, "test", "fixtures", "rex");
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    const listed = [...readme.matchAll(/^\| `([\w.-]+\.vt)` \|/gm)].map((m) => m[1]);
    assert.ok(listed.length >= 3, `README table lists ${listed.length} fixtures`);
    for (const name of listed) {
      assert.ok(existsSync(join(dir, name)), `${name} is missing`);
      assert.ok(statSync(join(dir, name)).size > 0, `${name} is empty`);
    }
  });
});

describe("no real rex in tests", () => {
  const q = ['"', "'", "`"];
  const call = (fn, quote, gap = "") => `${fn}(${gap}${quote}rex${quote}, ["api"])`;

  it("the scan fails every way a test can reach rex unless isolateRex is called at module top level", () => {
    const reaches = [
      ...["execFileSync", "spawnSync", "spawn", "execFile"].flatMap((fn) => q.flatMap((quote) => [call(fn, quote), call(fn, quote, "\n  ")])),
      'execSync("rex whoami --json")',
      'execFileSync("/bin/sh", ["-c", "rex --autostart=false whoami"])',
      'execSync("cd /x && rex api call session.list")',
      'const bin = "rex"; spawnSync(bin, [])',
      'const m = await import("../dist/rexCli.js");',
      'const p = join(REPO, "dist", "rexCli.js");',
      'const fake = join(REPO, "test", "fixtures", "fake-rex", "rex");',
    ];
    for (const text of reaches) {
      assert.deepEqual(rexCallScanViolations("test/x.test.mjs", text), ["test/x.test.mjs"], text);
      assert.deepEqual(rexCallScanViolations("test/x.test.mjs", `const f = isolateRex(tmp);\n${text}`), [], `isolated: ${text}`);
      assert.deepEqual(rexCallScanViolations("test/x.test.mjs", `function g() {\n  isolateRex(tmp);\n}\n${text}`), ["test/x.test.mjs"], `nested: ${text}`);
    }
    for (const clean of ['execFileSync("rexy", [])', 'spawnSync("tmux", [])', 'const allow = ["src/rexCli.ts"];', 'HIVE_TERMINAL: "rex"']) {
      assert.deepEqual(rexCallScanViolations("test/x.test.mjs", clean), [], clean);
    }
  });

  it("no test file runs a real rex binary", () => {
    const dir = join(REPO, "test");
    const files = readdirSync(dir).filter((f) => f.endsWith(".mjs"));
    assert.ok(files.includes("rex-cli.test.mjs") && files.includes("rex-helpers.mjs"));
    const violations = files.flatMap((f) => rexCallScanViolations(`test/${f}`, readFileSync(join(dir, f), "utf8")));
    assert.deepEqual(violations, []);
  });

  it("isolateRex puts the fake first on PATH, so a bare rex is the fake", () => {
    const resolved = execFileSync("/bin/sh", ["-c", "command -v rex"], { env: fake.env, encoding: "utf8" }).trim();
    assert.equal(resolved, join(FAKE_REX_DIR, "rex"));
    const before = fake.calls().length;
    const out = execFileSync("/bin/sh", ["-c", "rex --autostart=false --timeout 10s whoami --json"], { env: fake.env, encoding: "utf8" });
    assert.ok(JSON.parse(out));
    const logged = fake.calls().slice(before);
    assert.equal(logged.length, 1);
    assert.ok(logged[0].argv.includes("whoami"));
    for (const key of ["REX_BLOCK", "REX_SESSION", "OSC7577_TOKEN"]) assert.equal(fake.env[key], undefined, key);
    assert.equal(fake.env.REX_SERVER, `unix://${tmp}/fake-rex.sock`);
  });
});
