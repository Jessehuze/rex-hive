import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { REPO } from "./helpers.mjs";
import { FAKE_REX_DIR, fakeRexDo, isolateRex, rexCallScanViolations, waitFor } from "./rex-helpers.mjs";

const tmp = mkdtempSync(join(tmpdir(), "hive-rex-cli-"));
const fake = isolateRex(tmp);
const REX_ADDR = fake.env.REX_SERVER;
const SHELL = "com.superlogical.terminal.shell";

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
    initial_windows: [{ window_label: label, layout: { block: { flavor: SHELL, label, options: { shell: "none", command } } } }],
  });
  return { session: made.session_id, window: made.initial_windows[0].window_id, block: made.initial_windows[0].block_ids[0] };
}

const screenOf = async (b) =>
  (await cli()).rexApi(REX_ADDR, "block.method", { session_id: b.session, block_id: b.block, method: "format", args: { format: "plain" } }).content;

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
        (e) => e instanceof RexUnavailableError && /connection refused/.test(e.stderr),
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
    assert.equal(hung[0].argv[hung[0].argv.indexOf("--timeout") + 1], "1s");
    assert.equal(alive(hung[0].pid), false, "the hung rex process was killed");
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

  it("rexLua runs do -e with --json and returns the parsed snapshot naming each block's pid", async () => {
    const { rexLua, SNAPSHOT_SCRIPT } = await cli();
    assert.equal(SNAPSHOT_SCRIPT.split("\n")[0], "-- hive:snapshot v1");
    const b = await newBlock(["sleep", "30"], "snap");
    const before = realCalls().length;
    const snap = rexLua(REX_ADDR, SNAPSHOT_SCRIPT);
    const [call] = realCalls().slice(before);
    assert.deepEqual(call.argv.slice(-4), ["do", "-e", SNAPSHOT_SCRIPT, "--json"]);
    assert.ok(snap.sessions.some((s) => s.session_id === b.session));
    const entry = snap.blocks.find((x) => x.block_id === b.block);
    assert.equal(entry.session_id, b.session);
    assert.equal(entry.process.child.pid, fake.state().blocks[b.block].child_pid);
    assert.ok(Array.isArray(entry.program_status.records));
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
      assert.deepEqual(runDefaultServerChild(down), [null, null]);
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

  it("isolateRex's exit cleanup kills every block process the file started", async () => {
    const helpers = join(REPO, "test", "rex-helpers.mjs");
    const dir = mkdtempSync(join(tmp, "child-"));
    const src = `
const { isolateRex } = await import(${JSON.stringify(helpers)});
const { execFileSync } = await import("node:child_process");
const f = isolateRex(${JSON.stringify(dir)});
const bin = "rex";
execFileSync(bin, ["--autostart=false", "--timeout", "10s", "-S", f.env.REX_SERVER, "api", "call", "session.create",
  JSON.stringify({ initial_windows: [{ layout: { block: { flavor: "com.superlogical.terminal.shell", options: { command: ["sleep", "60"] } } } }] })]);
const pids = Object.values(f.state().blocks).map((b) => b.child_pid);
console.log(JSON.stringify(pids));`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8" });
    const pids = JSON.parse(out);
    assert.equal(pids.length, 1);
    await waitFor(() => !alive(pids[0]));
  });

  it("stopServer fails every call with exit 1 and connection refused until restartServer", () => {
    fakeRexDo(tmp, "stopServer");
    try {
      const bin = "rex";
      const r = spawnSync(bin, ["--autostart=false", "--timeout", "10s", "-S", REX_ADDR, "api", "call", "session.list"], { env: fake.env, encoding: "utf8" });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /connection refused/);
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

describe("no real rex in tests", () => {
  const q = ['"', "'", "`"];
  const call = (fn, quote, gap = "") => `${fn}(${gap}${quote}rex${quote}, ["api"])`;

  it("the scan flags every direct exec form and quote style, and spares PATH-resolved names", () => {
    for (const fn of ["execFileSync", "spawnSync", "spawn", "execFile"]) {
      for (const quote of q) {
        assert.equal(rexCallScanViolations("test/x.test.mjs", call(fn, quote)).length, 1, call(fn, quote));
        assert.equal(rexCallScanViolations("test/x.test.mjs", call(fn, quote, "\n  ")).length, 1, `${fn} multi-line`);
      }
    }
    for (const clean of ['const bin = "rex"; execFileSync(bin, [])', 'execFileSync("rexy", [])', 'spawnSync("tmux", [])']) {
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
