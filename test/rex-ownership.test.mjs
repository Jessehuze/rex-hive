import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, scratchDirs } from "./helpers.mjs";
import { fakeRexDo, isolateRex, waitFor } from "./rex-helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("rex ownership tests");
const dirs = scratchDirs();
const fake = isolateRex(dirs.tmp);
clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
process.env.HIVE_TERMINAL = "rex";
const REX_ADDR = process.env.REX_SERVER;
const SOCKET = `rex:${REX_ADDR}`;

const { db, migrate } = await import("../dist/db.js");
migrate();
await import("../dist/rexInUse.js");
const terminal = await import("../dist/terminal.js");
const { janitor } = await import("../dist/scheduler.js");
const { rexApi } = await import("../dist/rexCli.js");
const { REX_UNREACHABLE_GRACE_MS, unreachableSinceKey } = await import("../dist/terminal/rex.js");

const BIN = join(dirs.tmp, "bin");
mkdirSync(BIN, { recursive: true });
writeFileSync(join(BIN, "claude"), "#!/bin/sh\nexec sleep 600\n");
chmodSync(join(BIN, "claude"), 0o755);
const CLAUDE = join(BIN, "claude");

let projectId;
let seq = 0;

before(() => {
  projectId = db.prepare("INSERT INTO projects (name, path) VALUES ('rexproj', ?) RETURNING id").get(dirs.projectDir).id;
});

after(() => {
  fake.cleanup();
  cleanupTmux();
  db.close();
});

const realCalls = () => fake.calls().filter((c) => c.argv[0] !== "__fake");
const doCalls = () => realCalls().filter((c) => c.argv.includes("do"));

function newBlock(label, command = ["sleep", "600"]) {
  const made = rexApi(REX_ADDR, "session.create", {
    label: `s-${label}-${++seq}`,
    initial_windows: [{ window_label: label, layout: { block: { flavor: "com.superlogical.terminal.shell", label, options: { shell: "none", command } } } }],
  });
  const block = made.initial_windows[0].block_ids[0];
  return { session: made.session_id, window: made.initial_windows[0].window_id, block, pid: String(fake.state().blocks[block].child_pid) };
}

function insertRow({ block, pid, kind = "command", command = "sleep 600", name = `p${++seq}`, actor = `process:${name}` }) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, pane_pid, command, cwd, kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', datetime('now', '-10 minutes')) RETURNING *`,
    )
    .get(projectId, actor, name, block, SOCKET, pid, command, dirs.projectDir, kind);
}

function insertWake(row) {
  return db
    .prepare(
      `INSERT INTO wakes (project_id, owner, body, deliver_actor, deliver_pane, due_at, created_at)
       VALUES (?, 'lead:rex', 'check the build', ?, ?, datetime('now', '+1 hour'), datetime('now', '-10 minutes')) RETURNING id`,
    )
    .get(projectId, row.actor_id, row.tmux_target).id;
}

const wakeById = (id) => db.prepare("SELECT * FROM wakes WHERE id = ?").get(id);
const rowById = (id) => db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
const deadProcessNotices = (name) =>
  db.prepare("SELECT * FROM wakes WHERE project_id = ? AND body LIKE ?").all(projectId, `[hive] process "${name}" exited on its own%`);
const identity = (row) => ({ tmux_target: row.tmux_target, tmux_socket: row.tmux_socket, pane_pid: row.pane_pid, command: row.command });

describe("Rex row ownership", () => {
  it("live when pid and argv match", () => {
    const b = newBlock("live");
    const row = insertRow({ block: b.block, pid: b.pid });
    assert.equal(terminal.rowOwnership(identity(row), terminal.liveTargets()), "live");
    assert.equal(terminal.rowOwnership(identity(row)), "live");
  });

  it("reissued when the block runs a different pid", () => {
    const b = newBlock("other-pid");
    const row = insertRow({ block: b.block, pid: String(Number(b.pid) + 100_000) });
    assert.equal(terminal.rowOwnership(identity(row), terminal.liveTargets()), "reissued");
  });

  it("reissued when the pid matches but the block's program is not the row's command", () => {
    const b = newBlock("other-argv");
    const row = insertRow({ block: b.block, pid: b.pid, command: "claude --resume x" });
    assert.equal(terminal.rowOwnership(identity(row), terminal.liveTargets()), "reissued");
  });

  it("unknown when the row recorded no pid, never live", () => {
    const b = newBlock("no-pid");
    const row = insertRow({ block: b.block, pid: "" });
    assert.equal(terminal.rowOwnership(identity(row), terminal.liveTargets()), "unknown");
  });

  it("exited block reads gone after its final screen is captured", async () => {
    const b = newBlock("exits", ["/bin/sh", "-c", "echo final words; exit 3"]);
    const row = insertRow({ block: b.block, pid: b.pid, command: "sh" });
    await waitFor(() => terminal.paneProcessExited(b.block) === true);
    assert.match(terminal.captureFinalScreen(b.block, 5), /final words/);
    assert.ok(fake.state().blocks[b.block], "the block is still open, holding its final screen");
    assert.equal(terminal.rowOwnership(identity(row), terminal.liveTargets()), "gone");
  });

  it("closed block reads gone and cancels its wake", () => {
    const lead = newBlock("lead", [CLAUDE]);
    insertRow({ block: lead.block, pid: lead.pid, kind: "lead", command: "claude", name: "lead", actor: "lead:rex" });
    const worker = newBlock("api");
    const row = insertRow({ block: worker.block, pid: worker.pid, name: "api" });
    const wake = insertWake(row);
    assert.equal(terminal.rowOwnership(identity(row), terminal.liveTargets()), "live");

    fakeRexDo(dirs.tmp, "closeBlock", { block_id: worker.block });
    janitor();

    assert.equal(terminal.rowOwnership(identity(row), terminal.liveTargets()), "gone");
    assert.equal(rowById(row.id).status, "closed");
    assert.notEqual(wakeById(wake).cancelled_at, null, "the wake to the closed block is cancelled");
    const notices = deadProcessNotices("api");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].deliver_pane, lead.block, "the notice is aimed at the lead's block");
    janitor();
    assert.equal(deadProcessNotices("api").length, 1, "a second tick files nothing more");
  });

  it("one snapshot spawn per liveTargets call regardless of block count", () => {
    const rows = Array.from({ length: 6 }, (_, i) => {
      const b = newBlock(`many-${i}`);
      return insertRow({ block: b.block, pid: b.pid });
    });
    const beforeAll = realCalls().length;
    const beforeDo = doCalls().length;
    const snapshot = terminal.liveTargets();
    for (const row of rows) assert.equal(terminal.rowOwnership(identity(row), snapshot), "live");
    assert.equal(doCalls().length - beforeDo, 1);
    assert.equal(realCalls().length - beforeAll, 1, "ownership from the snapshot makes no further rex call");
  });

  it("unreachable server holds for the grace window then reads gone", () => {
    const b = newBlock("grace");
    const row = insertRow({ block: b.block, pid: b.pid, name: "grace" });
    const wake = insertWake(row);
    fakeRexDo(dirs.tmp, "stopServer");

    janitor();
    assert.equal(terminal.rowOwnership(identity(row), terminal.liveTargets()), "unknown");
    assert.equal(rowById(row.id).status, "running", "an unreachable server never closes a row inside the window");
    assert.equal(wakeById(wake).cancelled_at, null, "and its wake is held, not cancelled");
    const key = unreachableSinceKey(REX_ADDR);
    const since = Number(db.prepare("SELECT value FROM kv WHERE key = ?").get(key).value);
    assert.ok(Date.now() - since < REX_UNREACHABLE_GRACE_MS);

    db.prepare("UPDATE kv SET value = CAST(CAST(value AS INTEGER) - 601000 AS TEXT) WHERE key = ?").run(key);
    assert.equal(terminal.rowOwnership(identity(row), terminal.liveTargets()), "gone");
    janitor();
    assert.equal(rowById(row.id).status, "closed");
    assert.notEqual(wakeById(wake).cancelled_at, null);

    fakeRexDo(dirs.tmp, "restartServer");
    terminal.liveTargets();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kv WHERE key = ?").get(key).n, 0, "an answered snapshot clears the marker");
  });
});
