import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { McpClient, REPO, clearHiveEnv, isolateTmux, scratchDirs, sleep } from "./helpers.mjs";
import { fakeRexDo, isolateRex, waitFor } from "./rex-helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("rex program-status hold tests");
const dirs = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
process.env.HIVE_TERMINAL = "rex";
const fake = isolateRex(dirs.tmp);
const REX_ADDR = process.env.REX_SERVER;
const SOCKET = `rex:${REX_ADDR}`;

const { db, migrate } = await import("../dist/db.js");
if (!db.name.startsWith(dirs.dataDir)) throw new Error(`refusing: opened ${db.name}`);
migrate();
await import("../dist/rexInUse.js");
const terminal = await import("../dist/terminal.js");
const { tick } = await import("../dist/scheduler.js");
const { rexApi } = await import("../dist/rexCli.js");
const { HELD_REASON_MODAL_CHOICE } = await import("../dist/wakeSql.js");
const { shellQuote } = await import("../dist/tmux.js");

const BIN = join(dirs.tmp, "bin");
mkdirSync(BIN, { recursive: true });
writeFileSync(join(BIN, "claude"), "#!/bin/sh\nexec sleep 600\n");
chmodSync(join(BIN, "claude"), 0o755);
const CLAUDE = join(BIN, "claude");
const DIALOG = readFileSync(join(REPO, "test", "fixtures", "panes", "folder-trust-dialog.txt"), "utf8");
const BLOCKED = [{ state: "blocked", kind: "permission", app: "claude", msg: "approve Bash: ls" }];
const IDLE = [{ state: "idle", app: "claude" }];
const NO_SCHEDULER = { HIVE_SCHEDULER_INTERVAL_MS: "2147483647" };

let projectId;
let projectDir;
let seq = 0;
const clients = [];

before(() => {
  projectDir = mkdtempSync(join(dirs.tmp, "rex-status-"));
  writeFileSync(join(projectDir, "hive.yml"), "dashboard: false\nquiet_messaging: true\n");
  projectId = db.prepare("INSERT INTO projects (name, path) VALUES ('rexstatus', ?) RETURNING id").get(projectDir).id;
  db.prepare("INSERT INTO kv (project_id, key, value, updated_by) VALUES (?, 'terminal:rex:in-use', '1', 'test')").run(projectId);
});

after(async () => {
  for (const client of clients) await client.close().catch(() => {});
  fake.cleanup();
  cleanupTmux();
  db.close();
});

const doCalls = () => fake.calls().filter((c) => c.argv[0] !== "__fake" && c.argv.includes("do"));
const pastes = (block) => (fake.state().blocks[block]?.events ?? []).filter((e) => e.type === "paste");
const wakeById = (id) => db.prepare("SELECT * FROM wakes WHERE id = ?").get(id);
const setStatus = (block, records) => fakeRexDo(dirs.tmp, "setProgramStatus", { block_id: block, records });

function newBlock(label) {
  const made = rexApi(REX_ADDR, "session.create", {
    label: `s-${label}-${++seq}`,
    initial_windows: [{ window_label: label, layout: { block: { flavor: "com.superlogical.terminal.shell", label, options: { shell: "none", login: false, command: [CLAUDE] } } } }],
  });
  const block = made.initial_windows[0].block_ids[0];
  return { block, pid: String(fake.state().blocks[block].child_pid) };
}

function insertRow({ block, pid, kind = "agent", command = "claude", name = `w${++seq}` }) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, pane_pid, command, cwd, kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', datetime('now', '-10 minutes')) RETURNING *`,
    )
    .get(projectId, `${kind}:${name}`, name, block, SOCKET, pid, command, projectDir, kind);
}

function dueWake(row, body) {
  return db
    .prepare(
      `INSERT INTO wakes (project_id, owner, body, deliver_actor, deliver_pane, due_at, created_at)
       VALUES (?, 'lead:nobody', ?, ?, ?, datetime('now', '-1 second'), datetime('now', '-10 minutes')) RETURNING id`,
    )
    .get(projectId, body, row.actor_id, row.tmux_target).id;
}

function closeRow(row, wake) {
  if (wake) db.prepare("UPDATE wakes SET cancelled_at = datetime('now') WHERE id = ?").run(wake);
  db.prepare("UPDATE agents SET status = 'closed' WHERE id = ?").run(row.id);
}

describe("programStatusBlocks", () => {
  const snap = (target, status) => ({
    panes: new Set([target]),
    windows: new Set(),
    pids: new Map(),
    rex: { answered: true, server: REX_ADDR, incomplete: false, unreachableSince: null, blocks: new Map([[target, { status }]]) },
  });

  it("tmux rows ignore program status", () => {
    const blocked = { state: "blocked", kind: "permission", msg: "approve Bash: ls" };
    assert.equal(terminal.programStatusBlocks("%7", snap("%7", blocked)), false);
    assert.equal(terminal.programStatusBlocks("block:b7", snap("block:b7", blocked)), true);
  });

  it("blocked state or a permission, question or auth kind blocks; idle, a missing status and no snapshot do not", () => {
    const at = (status) => terminal.programStatusBlocks("block:b8", snap("block:b8", status));
    assert.equal(at({ state: "running", kind: "question", msg: null }), true);
    assert.equal(at({ state: "running", kind: "auth", msg: null }), true);
    assert.equal(at({ state: "running", kind: "permission", msg: null }), true);
    assert.equal(at({ state: "blocked", kind: null, msg: null }), true);
    assert.equal(at({ state: "idle", kind: null, msg: null }), false);
    assert.equal(at({ state: "running", kind: "progress", msg: null }), false);
    assert.equal(at(null), false);
    assert.equal(terminal.programStatusBlocks("block:b8", null), false);
    assert.equal(terminal.programStatusBlocks("block:missing", snap("block:b8", { state: "blocked", kind: null, msg: null })), false);
  });
});

describe("Rex program-status holds on wakes", () => {
  it("Rex blocked status holds a wake even when the screen scrape says clear", async () => {
    const b = newBlock("blocked");
    const row = insertRow(b);
    setStatus(b.block, BLOCKED);
    assert.equal(terminal.paneAwaitingChoice(b.block), false, "the screen shows no dialog");
    const wake = dueWake(row, "held by rex status");
    await tick();
    await sleep(300);
    assert.deepEqual(pastes(b.block), []);
    assert.equal(wakeById(wake).held_reason, HELD_REASON_MODAL_CHOICE);
    assert.equal(wakeById(wake).fired_at, null);
    assert.equal(wakeById(wake).cancelled_at, null);

    setStatus(b.block, IDLE);
    await tick();
    await waitFor(() => pastes(b.block).length === 1, { timeoutMs: 8000 });
    assert.match(pastes(b.block)[0].payload.text, /held by rex status/);
    closeRow(row);
  });

  it("Rex idle status never releases a scrape-detected dialog hold", async () => {
    const b = newBlock("dialog");
    const row = insertRow(b);
    fakeRexDo(dirs.tmp, "setScreen", { block_id: b.block, text: DIALOG });
    setStatus(b.block, IDLE);
    assert.equal(terminal.paneAwaitingChoice(b.block), true, "the screen shows a dialog");
    const wake = dueWake(row, "held by the screen");
    await tick();
    await tick();
    await sleep(300);
    assert.deepEqual(pastes(b.block), []);
    assert.equal(wakeById(wake).held_reason, HELD_REASON_MODAL_CHOICE);
    assert.equal(wakeById(wake).fired_at, null);
    closeRow(row, wake);
  });

  it("the status check reads the tick's own snapshot and spawns no rex do of its own", async () => {
    const blocks = Array.from({ length: 3 }, (_, i) => newBlock(`count-${i}`));
    const rows = blocks.map((b) => insertRow(b));
    for (const b of blocks) setStatus(b.block, BLOCKED);
    const wakes = rows.map((row) => dueWake(row, "counted"));
    const beforeDo = doCalls().length;
    await tick();
    assert.equal(doCalls().length - beforeDo, 1, "one snapshot do per tick, whatever the number of held wakes");
    for (const id of wakes) assert.equal(wakeById(id).held_reason, HELD_REASON_MODAL_CHOICE);
    rows.forEach((row, i) => closeRow(row, wakes[i]));
  });
});

describe("Rex program-status holds on lead messages", () => {
  it("agent_send to a blocked Rex lead is held, not typed", async () => {
    const b = newBlock("lead");
    const hooks = join(dirs.dataDir, `lead-${projectId}-hooks.json`);
    const lead = insertRow({ ...b, kind: "lead", name: "lead", command: ["claude", "--settings", hooks].map(shellQuote).join(" ") });
    const sender = insertRow({ block: "block:none", pid: "1", name: "sender" });
    setStatus(b.block, BLOCKED);
    const client = new McpClient({ cwd: projectDir, dataDir: dirs.dataDir, env: { ...fake.env, HIVE_AGENT_ID: sender.actor_id, ...NO_SCHEDULER } });
    await client.start();
    clients.push(client);

    const beforeDo = doCalls().length;
    const receipt = await client.call("agent_send", { name: "lead", text: "report from the sender" });
    assert.equal(doCalls().length - beforeDo, 2, "requireLive's probe and the fallback's one ownership snapshot, which also carries the status");
    assert.equal(receipt.sent, false, JSON.stringify(receipt));
    assert.equal(receipt.pending, true, JSON.stringify(receipt));
    const message = () => db.prepare("SELECT * FROM agent_messages WHERE id = ?").get(receipt.message_id);
    assert.equal(message().delivery_status, "fallback-pending");
    assert.equal(message().delivery_note, HELD_REASON_MODAL_CHOICE);
    await tick();
    await sleep(300);
    assert.deepEqual(pastes(b.block), []);
    assert.equal(message().delivery_note, HELD_REASON_MODAL_CHOICE);

    setStatus(b.block, IDLE);
    await tick();
    await waitFor(() => pastes(b.block).length === 1, { timeoutMs: 8000 });
    assert.match(pastes(b.block)[0].payload.text, /report from the sender/);
    assert.equal(message().delivery_status, "complete");
    closeRow(lead);
    closeRow(sender);
  });
});
