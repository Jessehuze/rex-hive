import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";
import { FAKE_REX_DIR, fakeRexDo, isolateRex } from "./rex-helpers.mjs";

const { hasTmux, cleanup: cleanupTmux } = isolateTmux("rex doctor tests");
clearHiveEnv();
const dirs = scratchDirs();
const fake = isolateRex(dirs.tmp);
process.env.HIVE_DATA_DIR = dirs.dataDir;
const REX_ADDR = process.env.REX_SERVER;
const SOCKET = `rex:${REX_ADDR}`;
const SHELL = "com.superlogical.terminal.shell";

const { db, migrate } = await import("../dist/db.js");
if (!db.name.startsWith(dirs.dataDir)) throw new Error(`refusing: opened ${db.name}`);
migrate();
await import("../dist/rexInUse.js");
const { rexApi } = await import("../dist/rexCli.js");
const { REX_MIN_API_REVISION } = await import("../dist/terminal/rex.js");
const { renameAgent } = await import("../dist/spawn.js");

after(() => {
  fake.cleanup();
  cleanupTmux();
});

const realCalls = () => fake.calls().filter((c) => c.argv[0] !== "__fake");
const apiMethods = (calls) => calls.map((c) => (c.argv.includes("call") ? c.argv[c.argv.indexOf("call") + 1] : c.argv.find((a) => !a.startsWith("-") && !/^\d/.test(a) && !a.startsWith("unix:"))));

const claudeDir = mkdtempSync(join(dirs.tmp, "claude-config-"));
function claudeSettings(command) {
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify(command === null ? {} : { hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command }] }] } }),
  );
}

async function project(name) {
  const dir = mkdtempSync(join(dirname(dirs.projectDir), `${name}-`));
  writeFileSync(join(dir, "hive.yml"), "dashboard: false\n");
  const init = await runCli(["init", "--no-profile"], { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp, env: { ...fake.env } });
  assert.equal(init.code, 0, init.stdout + init.stderr);
  return db.prepare("SELECT id, name, path FROM projects WHERE path = ?").get(dir);
}

function newBlock(label) {
  const made = rexApi(REX_ADDR, "session.create", {
    label: `s-${label.replaceAll("/", "-")}`,
    initial_windows: [{ window_label: label, layout: { block: { flavor: SHELL, label, options: { shell: "none", login: false, command: ["/bin/sleep", "600"] } } } }],
  });
  const block = made.initial_windows[0].block_ids[0];
  return { session: made.session_id, block, pid: String(fake.state().blocks[block].child_pid) };
}

function insertRow(p, { name, kind = "agent", target, pid = "", socket = SOCKET }) {
  const id = db
    .prepare(
      `INSERT INTO agents (project_id, name, command, cwd, kind, status, tmux_target, tmux_socket, pane_pid)
       VALUES (?, ?, 'sleep 600', ?, ?, 'running', ?, ?, ?) RETURNING id`,
    )
    .get(p.id, name, p.path, kind, target, socket, pid).id;
  const actor = `${kind === "lead" ? "lead" : "agent"}:${id}`;
  db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES (?, ?, ?)").run(actor, name, kind === "lead" ? "lead" : "agent");
  db.prepare("UPDATE agents SET actor_id = ? WHERE id = ?").run(actor, id);
  return id;
}

function closeRunningRows() {
  db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE status = 'running'").run();
  for (const block of Object.keys(fake.state().blocks)) fakeRexDo(dirs.tmp, "closeBlock", { block_id: block });
}

async function doctor(p, env = {}) {
  const result = await runCli(["doctor"], {
    cwd: p.path,
    dataDir: dirs.dataDir,
    tmp: dirs.tmp,
    env: { ...fake.env, ...doctorEnv, ...env },
  });
  return result.stdout;
}

const doctorEnv = { HIVE_NO_UPDATE_CHECK: "1", CLAUDE_CONFIG_DIR: claudeDir, HIVE_BIN_DIR: join(dirs.tmp, "no-dispatcher-bin") };

const line = (out, label) => out.split("\n").find((l) => new RegExp(`^ {2}(?:ok {4}|warn {2}|FAIL {2}|info {2})${label}: `).test(l)) ?? null;

describe("hive doctor under Rex", () => {
  it("doctor reports the Rex section when terminal is rex", async () => {
    const p = await project("rex-doctor-section");
    const lead = newBlock(`${p.name}/lead`);
    insertRow(p, { name: "lead", kind: "lead", target: lead.block, pid: lead.pid });
    fakeRexDo(dirs.tmp, "setServerInfo", { rex_version: "0.1.0-test" });
    const installed = await runCli(["setup", "--rex-resume", "--install"], { cwd: p.path, dataDir: dirs.dataDir, tmp: dirs.tmp, env: { ...fake.env, ...doctorEnv } });
    assert.equal(installed.code, 0, installed.stdout + installed.stderr);
    claudeSettings("/bin/sh -c 'rex __internal session-start --agent claude --feature-session-naming=true 2>/dev/null || true'");
    try {
      const out = await doctor(p, { HIVE_TERMINAL: "rex" });
      assert.equal(line(out, "terminal"), "  ok    terminal: rex (from env)");
      assert.equal(line(out, "rex"), `  ok    rex: ${join(FAKE_REX_DIR, "rex")}`);
      assert.equal(line(out, "rex server"), `  ok    rex server: reachable, version 0.1.0-test, api_revision 24 (minimum ${REX_MIN_API_REVISION})`);
      assert.equal(line(out, "rex blocks"), "  ok    rex blocks: 1 owned, 0 rows gone, 0 orphan blocks");
      assert.equal(line(out, "rex resume rule"), "  ok    rex resume rule: installed");
      assert.equal(line(out, "rex session naming hook"), "  warn  rex session naming hook: ON (workers may rename your session)");

      writeFileSync(fake.configPath, "");
      claudeSettings("/bin/sh -c 'rex __internal session-start --agent claude --feature-session-naming=false 2>/dev/null || true'");
      const off = await doctor(p, { HIVE_TERMINAL: "rex" });
      assert.equal(line(off, "rex resume rule"), "  warn  rex resume rule: missing");
      assert.equal(line(off, "rex session naming hook"), "  ok    rex session naming hook: off");
    } finally {
      fakeRexDo(dirs.tmp, "setServerInfo", { rex_version: "0.0.0-fake" });
      rmSync(fake.configPath, { force: true });
      claudeSettings(null);
      closeRunningRows();
    }
  });

  it("doctor skips tmux-only checks with no tmux rows under rex", { skip: hasTmux ? false : "tmux is not installed" }, async () => {
    const p = await project("rex-doctor-gate");
    const lead = newBlock(`${p.name}/lead`);
    insertRow(p, { name: "lead", kind: "lead", target: lead.block, pid: lead.pid });
    try {
      const rexOnly = await doctor(p, { HIVE_TERMINAL: "rex" });
      for (const label of ["tmux", "sessions", "window stamps"]) assert.equal(line(rexOnly, label), null, `${label} is skipped:\n${rexOnly}`);
      assert.ok(line(rexOnly, "rex blocks"), rexOnly);

      insertRow(p, { name: "tmux-worker", target: "%999999", socket: "/nonexistent/tmux-socket" });
      const mixed = await doctor(p, { HIVE_TERMINAL: "rex" });
      for (const label of ["tmux", "sessions", "window stamps"]) assert.ok(line(mixed, label), `${label} runs once a tmux row exists:\n${mixed}`);
    } finally {
      closeRunningRows();
    }
  });

  it("doctor names orphan hive-labelled blocks with no row, and rows whose block is gone", async () => {
    const p = await project("rex-doctor-orphan");
    const lead = newBlock(`${p.name}/lead`);
    insertRow(p, { name: "lead", kind: "lead", target: lead.block, pid: lead.pid });
    const orphan = newBlock(`${p.name}/worker-1`);
    const stranger = newBlock("someone-else/notes");
    insertRow(p, { name: "worker-2", target: "block:00000000-0000-4000-8000-000000000000", pid: "1" });
    try {
      const out = await doctor(p, { HIVE_TERMINAL: "rex" });
      assert.equal(line(out, "rex blocks"), "  warn  rex blocks: 1 owned, 1 rows gone, 1 orphan blocks", out);
      assert.match(out, new RegExp(`worker-2: block:00000000-0000-4000-8000-000000000000 is gone`));
      assert.match(out, new RegExp(`${p.name}/worker-1 ${orphan.block} has no hive row; close it with: rex block close ${orphan.block}`));
      assert.doesNotMatch(out, new RegExp(stranger.block));
    } finally {
      fakeRexDo(dirs.tmp, "closeBlock", { block_id: orphan.block });
      fakeRexDo(dirs.tmp, "closeBlock", { block_id: stranger.block });
      closeRunningRows();
    }
  });

  it("crash between move and close leaves an orphan that doctor reports", async () => {
    const p = await project("rex-doctor-crash");
    const old = newBlock(`${p.name}/lead`);
    const row = insertRow(p, { name: "lead", kind: "lead", target: old.block, pid: old.pid });
    const successor = rexApi(REX_ADDR, "session.new_split", {
      session_id: old.session, anchor_id: old.block, direction: "horizontal", side: "after", focus: false,
      layout: { block: { flavor: SHELL, label: `${p.name}/lead`, options: { shell: "none", login: false, command: ["/bin/sleep", "600"] } } },
    }).block_ids[0];
    db.prepare("UPDATE agents SET tmux_target = ?, pane_pid = ? WHERE id = ?").run(successor, String(fake.state().blocks[successor].child_pid), row);
    try {
      const out = await doctor(p, { HIVE_TERMINAL: "rex" });
      assert.equal(line(out, "rex blocks"), "  warn  rex blocks: 1 owned, 0 rows gone, 1 orphan blocks", out);
      assert.match(out, new RegExp(`${p.name}/lead ${old.block} has no hive row`));
      assert.doesNotMatch(out, new RegExp(`${successor} has no hive row`));
    } finally {
      fakeRexDo(dirs.tmp, "closeBlock", { block_id: old.block });
      closeRunningRows();
    }
  });

  it("doctor warns when api_revision is below the minimum", async () => {
    const p = await project("rex-doctor-revision");
    fakeRexDo(dirs.tmp, "setServerInfo", { api_revision: REX_MIN_API_REVISION - 1 });
    try {
      const out = await doctor(p, { HIVE_TERMINAL: "rex" });
      const server = line(out, "rex server");
      assert.equal(server.split("\n")[0], `  warn  rex server: reachable, version 0.0.0-fake, api_revision ${REX_MIN_API_REVISION - 1} (minimum ${REX_MIN_API_REVISION})`);
      assert.match(out, /HIVE_TERMINAL=tmux/);
    } finally {
      fakeRexDo(dirs.tmp, "setServerInfo", { api_revision: 24 });
    }
  });

  it("doctor fails the server line when the Rex server is down, and still makes no attempt to start one", async () => {
    const p = await project("rex-doctor-down");
    fakeRexDo(dirs.tmp, "stopServer");
    try {
      const out = await doctor(p, { HIVE_TERMINAL: "rex" });
      assert.match(line(out, "rex server"), /^ {2}FAIL {2}rex server: the Rex server is unreachable: .*HIVE_TERMINAL=tmux/);
      assert.equal(line(out, "rex blocks"), null, "no block counts without a server");
      assert.equal(fake.state().server, "stopped");
    } finally {
      fakeRexDo(dirs.tmp, "restartServer");
    }
  });

  it("doctor clears pending reap entries whose server has been unreachable past the grace window, and keeps fresh ones", async () => {
    const p = await project("rex-doctor-reap");
    const put = (agent, server, age) =>
      db
        .prepare(`INSERT INTO kv (project_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, 'hive', datetime('now', ?))`)
        .run(p.id, `terminal:rex:reap:${agent}`, JSON.stringify({ agent, target: `block:gone-${agent}`, server, failures: 4 }), age);
    put(9001, "unix:///nonexistent/old.sock", "-11 minutes");
    put(9002, "unix:///nonexistent/new.sock", "-1 minutes");
    put(9003, REX_ADDR, "-11 minutes");
    const keys = () => db.prepare("SELECT key FROM kv WHERE key LIKE 'terminal:rex:reap:%' ORDER BY key").all().map((r) => r.key);
    try {
      const out = await doctor(p, { HIVE_TERMINAL: "rex" });
      assert.match(line(out, "rex reap"), /cleared 1 pending reap entry .*agent 9001/, out);
      assert.ok(!keys().includes("terminal:rex:reap:9001"), "the stale entry is gone");
      assert.ok(keys().includes("terminal:rex:reap:9002"), "an entry inside the grace window stays");
    } finally {
      db.prepare("DELETE FROM kv WHERE key LIKE 'terminal:rex:reap:%'").run();
    }
  });

  it("doctor on tmux prints no Rex section and makes no rex call", async () => {
    const p = await project("rex-doctor-tmux");
    const before = realCalls().length;
    const out = await doctor(p);
    assert.equal(line(out, "terminal"), null);
    assert.doesNotMatch(out, /^ {2}\S+ +rex[ :]/m);
    assert.deepEqual(realCalls().slice(before), []);
    if (hasTmux) assert.ok(line(out, "tmux"), "the tmux check still runs");
  });
});

describe("a lead resolved to Rex refuses when Rex cannot serve it", () => {
  const lead = (p, env) => runCli(["lead", p.path, "--detach"], { cwd: p.path, dataDir: dirs.dataDir, tmp: dirs.tmp, env: { ...fake.env, HIVE_TERMINAL: "rex", ...env } });
  const created = (calls) => apiMethods(calls).filter((m) => /^session\.(new_|create)/.test(m ?? ""));

  it("refuses with the way back when rex is not installed", async () => {
    const p = await project("rex-refuse-missing");
    const bare = mkdtempSync(join(dirs.tmp, "bare-bin-"));
    const path = [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
    assert.ok(path.split(delimiter).every((d) => !existsSync(join(d, "rex"))), "the stripped PATH really has no rex on it");
    const result = await lead(p, { PATH: `${bare}${delimiter}${path}` });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /rex is not installed or not on PATH.*HIVE_TERMINAL=tmux/s);
  });

  it("refuses with the way back when the Rex server is down", async () => {
    const p = await project("rex-refuse-down");
    fakeRexDo(dirs.tmp, "stopServer");
    const before = realCalls().length;
    try {
      const result = await lead(p);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr + result.stdout, /Rex server is unreachable.*HIVE_TERMINAL=tmux/s);
      assert.deepEqual(created(realCalls().slice(before)), []);
    } finally {
      fakeRexDo(dirs.tmp, "restartServer");
    }
  });

  it("refuses with the way back when api_revision is below the minimum, before creating any block", async () => {
    const p = await project("rex-refuse-revision");
    fakeRexDo(dirs.tmp, "setServerInfo", { api_revision: REX_MIN_API_REVISION - 1 });
    const before = realCalls().length;
    try {
      const result = await lead(p);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr + result.stdout, new RegExp(`api_revision ${REX_MIN_API_REVISION - 1}.*minimum ${REX_MIN_API_REVISION}.*HIVE_TERMINAL=tmux`, "s"));
      assert.ok(realCalls().slice(before).some((c) => c.argv.includes("whoami")), "the refusal came from asking the server");
      assert.deepEqual(created(realCalls().slice(before)), []);
    } finally {
      fakeRexDo(dirs.tmp, "setServerInfo", { api_revision: 24 });
    }
  });
});

describe("doctor's Rex config readers", () => {
  it("compares a rule's command word for word, accepts any rex.match placeholder in the id slot, and names the first word that differs", async () => {
    const { ruleDifference } = await import("../dist/rexResumeRule.js");
    const expected = ["/bin/sh", "-c", "script", "hive", "/pinned/hive", "__rex-resume", { match: "id" }];
    assert.equal(ruleDifference(["/bin/sh", "-c", "script", "hive", "/pinned/hive", "__rex-resume", { match: "id" }], expected), null);
    assert.equal(ruleDifference(["/bin/sh", "-c", "script", "hive", "/old/node", "/old/cli.js", "__rex-resume", { match: "id" }], expected), "names /old/node");
    assert.equal(ruleDifference(["/bin/sh", "-c", "script", "hive", "/pinned/hive", "__rex-resume", "rex.match.id"], expected), "names rex.match.id");
    assert.equal(ruleDifference(["/bin/sh", "-c", "script", "hive", "/pinned/hive"], expected), "lacks __rex-resume");
    assert.equal(ruleDifference([...expected, "--data-dir"], expected), "names --data-dir");
    assert.equal(ruleDifference("not a list", expected), "a command that is not a list");
  });

  it("reads --feature-session-naming false with a space, =false and a quoted false as off, and every other spelling as on", async () => {
    const { namingOnIn } = await import("../dist/rexDoctor.js");
    const hook = (flag) => `/bin/sh -c 'rex __internal session-start --agent claude ${flag} 2>/dev/null || true'`;
    for (const off of ["--feature-session-naming=false", "--feature-session-naming false", '--feature-session-naming "false"', ""]) assert.equal(namingOnIn(hook(off)), false, off);
    for (const on of ["--feature-session-naming", "--feature-session-naming=true", "--feature-session-naming true", "--session-naming"]) assert.equal(namingOnIn(hook(on)), true, on);
    assert.equal(namingOnIn("other-tool --feature-session-naming"), false, "only Rex's session-start hook counts");
  });
});

describe("agent rename on Rex", () => {
  it("relabels the worker's Rex block to the new name", async () => {
    const p = await project("rex-rename");
    const worker = newBlock(`${p.name}/old-name`);
    const id = insertRow(p, { name: "old-name", target: worker.block, pid: worker.pid });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    try {
      renameAgent(agent, "new-name", p.name);
      assert.equal(fake.state().blocks[worker.block].label, `${p.name}/new-name`);
      assert.equal(db.prepare("SELECT name FROM agents WHERE id = ?").get(id).name, "new-name");
    } finally {
      fakeRexDo(dirs.tmp, "closeBlock", { block_id: worker.block });
      closeRunningRows();
    }
  });
});

