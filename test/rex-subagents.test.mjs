import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { McpClient, clearHiveEnv, isolateTmux, resolvedTmuxSocket, runCli, scratchDirs, tmux } from "./helpers.mjs";
import { fakeRexDo, isolateRex } from "./rex-helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("rex subagent display tests");
const dirs = scratchDirs();
clearHiveEnv();
const fake = isolateRex(dirs.tmp);
process.env.HIVE_DATA_DIR = dirs.dataDir;
process.env.HIVE_TERMINAL = "rex";
const REX_ADDR = process.env.REX_SERVER;
const SOCKET = `rex:${REX_ADDR}`;

const { db, migrate } = await import("../dist/db.js");
if (!db.name.startsWith(dirs.dataDir)) throw new Error(`refusing: opened ${db.name}`);
migrate();
await import("../dist/rexInUse.js");
const terminal = await import("../dist/terminal.js");
const { rexApi } = await import("../dist/rexCli.js");
const { REX_IN_USE_KEY } = await import("../dist/terminal/rex.js");
const { tick } = await import("../dist/scheduler.js");

const BIN = join(dirs.tmp, "bin");
mkdirSync(BIN, { recursive: true });
writeFileSync(join(BIN, "claude"), "#!/bin/sh\nexec sleep 600\n");
chmodSync(join(BIN, "claude"), 0o755);
const CLAUDE = join(BIN, "claude");
const NO_SCHEDULER = { HIVE_SCHEDULER_INTERVAL_MS: "2147483647" };

const ROOT = { state: "working", app: "claude-code", effective_app: "claude-code", updated_at: "2000-01-01T00:00:00Z", owner: { pid: 4242, name: "claude" } };
const child = (id, title) => ({ id, state: "working", ...(title === undefined ? {} : { title }), app: "claude-code", effective_app: "claude-code", owner: { pid: 4243, name: "claude" } });
const SUBAGENT = child("a0f1e2d3c4b5a6978", "review the parser");
const SHELL = child("bx7k2q9pz", "Run the build in background");

let projectId;
let projectDir;
let seq = 0;
const clients = [];
const tmuxSessions = [];

before(() => {
  projectDir = mkdtempSync(join(dirs.tmp, "rex-subagents-"));
  writeFileSync(join(projectDir, "hive.yml"), "dashboard: false\n");
  projectId = db.prepare("INSERT INTO projects (name, path) VALUES ('rexsubagents', ?) RETURNING id").get(projectDir).id;
  db.prepare("INSERT INTO kv (project_id, key, value, updated_by) VALUES (?, ?, '1', 'test')").run(projectId, REX_IN_USE_KEY);
});

after(async () => {
  for (const client of clients) await client.close().catch(() => {});
  fake.cleanup();
  for (const session of tmuxSessions) tmux("kill-session", "-t", `=${session}`);
  cleanupTmux();
  db.close();
});

const realCalls = () => fake.calls().filter((c) => c.argv[0] !== "__fake");
const setStatus = (block, records, extra = {}) => fakeRexDo(dirs.tmp, "setProgramStatus", { block_id: block, records, ...extra });
const setRawReply = (block, reply) => fakeRexDo(dirs.tmp, "setProgramStatus", { block_id: block, reply });

function newBlock(label) {
  const made = rexApi(REX_ADDR, "session.create", {
    label: `s-${label}-${++seq}`,
    initial_windows: [{ window_label: label, layout: { block: { flavor: "com.superlogical.terminal.shell", label, options: { shell: "none", login: false, command: [CLAUDE] } } } }],
  });
  const block = made.initial_windows[0].block_ids[0];
  return { block, pid: String(fake.state().blocks[block].child_pid) };
}

function insertRow({ block, pid, socket = SOCKET, kind = "agent", name = `w${++seq}`, project = projectId, cwd = projectDir }) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, pane_pid, command, cwd, kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'claude', ?, ?, 'running', datetime('now', '-10 minutes')) RETURNING *`,
    )
    .get(project, `${kind}:${name}`, name, block, socket, pid, cwd, kind);
}

function tmuxPane(name) {
  const session = `subs-${name}-${++seq}`;
  tmuxSessions.push(session);
  const [pane, pid] = tmux("new-session", "-d", "-s", session, "-P", "-F", "#{pane_id}\t#{pane_pid}", "sleep 600").split("\t");
  return { block: pane, pid, socket: resolvedTmuxSocket() };
}

const closeRow = (row) => db.prepare("UPDATE agents SET status = 'closed' WHERE id = ?").run(row.id);

async function client(cwd = projectDir) {
  const c = new McpClient({ cwd, dataDir: dirs.dataDir, env: { ...fake.env, ...NO_SCHEDULER } });
  await c.start();
  clients.push(c);
  return c;
}

describe("Rex subagent display in agent_status and agent_list", () => {
  it("agent_status shows live subagent count and titles for a Rex worker", async () => {
    const b = newBlock("subs");
    const row = insertRow({ ...b, name: "subs" });
    const c = await client();
    setStatus(b.block, [{ ...ROOT, msg: "2 shells still running" }, SUBAGENT, SHELL, child("parent/child-1", "nested one"), child("untitled-9")]);
    const status = await c.call("agent_status", { name: "subs" });
    assert.equal(status.alive, true, JSON.stringify(status));
    assert.deepEqual(status.subagents, { count: 4, titles: ["review the parser", "Run the build in background", "nested one", "untitled-9"] });
    const listed = (await c.call("agent_list")).agents.find((a) => a.name === "subs");
    assert.deepEqual(listed.subagents, status.subagents);

    setStatus(b.block, [ROOT]);
    assert.deepEqual((await c.call("agent_status", { name: "subs" })).subagents, { count: 0, titles: [] });
    setStatus(b.block, []);
    assert.deepEqual((await c.call("agent_status", { name: "subs" })).subagents, { count: 0, titles: [] }, "a read with no records at all is zero, not unknown");
    setRawReply(b.block, { status: "ok" });
    assert.equal((await c.call("agent_status", { name: "subs" })).subagents, null, "a reply with no records list is unknown, not zero");
    setRawReply(b.block, { records: "garbled" });
    assert.equal((await c.call("agent_status", { name: "subs" })).subagents, null, "a records value that is not a list is unknown, not zero");
    closeRow(row);
  });

  it("agent_status adds no rex call for subagents: program_status is read only inside its one snapshot script", async () => {
    const b = newBlock("calls");
    const row = insertRow({ ...b, name: "calls" });
    const c = await client();
    setStatus(b.block, [ROOT, SUBAGENT]);
    const mark = realCalls().length;
    const status = await c.call("agent_status", { name: "calls" });
    assert.equal(status.subagents.count, 1);
    const calls = realCalls().slice(mark).map((cl) => cl.argv.join(" "));
    assert.equal(calls.filter((line) => /program_status/.test(line) && !/hive:snapshot v1/.test(line)).length, 0, calls.join("\n"));
    assert.equal(calls.filter((line) => /hive:snapshot v1/.test(line)).length, 1, calls.join("\n"));
    closeRow(row);
  });

  it("subagents is null for a Rex worker whose program status could not be read", async () => {
    const b = newBlock("unread");
    const row = insertRow({ ...b, name: "unread" });
    const c = await client();
    setStatus(b.block, [ROOT, SUBAGENT], { fails: true });
    const status = await c.call("agent_status", { name: "unread" });
    assert.equal(status.alive, true, JSON.stringify(status));
    assert.equal(status.subagents, null);
    setStatus(b.block, [ROOT, SUBAGENT]);
    assert.equal((await c.call("agent_status", { name: "unread" })).subagents.count, 1, "the same block reads once the method answers");
    closeRow(row);
  });

  it("subagents is null for tmux workers", async () => {
    const row = insertRow({ ...tmuxPane("status"), name: "tmuxrow" });
    const c = await client();
    const status = await c.call("agent_status", { name: "tmuxrow" });
    assert.equal(status.alive, true, JSON.stringify(status));
    assert.ok("subagents" in status, JSON.stringify(status));
    assert.equal(status.subagents, null);
    const listed = (await c.call("agent_list", { include_closed: true })).agents.find((a) => a.name === "tmuxrow");
    assert.ok("subagents" in listed && listed.subagents === null, JSON.stringify(listed));
    closeRow(row);
  });

  it("titles are capped at 5 and 80 chars", async () => {
    const b = newBlock("cap");
    const row = insertRow({ ...b, name: "cap" });
    const c = await client();
    const long = `${"x".repeat(200)}`;
    const kids = [child("k1", long), ...Array.from({ length: 6 }, (_, i) => child(`k${i + 2}`, `kid ${i + 2}`))];
    setStatus(b.block, [ROOT, ...kids]);
    const { subagents } = await c.call("agent_status", { name: "cap" });
    assert.equal(subagents.count, 7, "count is every child record, not the capped list");
    assert.equal(subagents.titles.length, 5);
    assert.ok(subagents.titles.every((t) => t.length <= 80), JSON.stringify(subagents.titles));
    assert.equal(subagents.titles[0].length, 80, "a long title is cut to the cap, not dropped");
    assert.ok(subagents.titles[0].startsWith("x".repeat(79)));
    assert.deepEqual(subagents.titles.slice(1), ["kid 2", "kid 3", "kid 4", "kid 5"]);
    closeRow(row);
  });

  it("a long title is cut on code points, never splitting a surrogate pair", async () => {
    const b = newBlock("emoji");
    const row = insertRow({ ...b, name: "emoji" });
    const c = await client();
    setStatus(b.block, [ROOT, child("e1", `${"y".repeat(78)}\u{1F600}\u{1F600}\u{1F600}`)]);
    const [title] = (await c.call("agent_status", { name: "emoji" })).subagents.titles;
    assert.equal(Array.from(title).length, 80, JSON.stringify(title));
    assert.equal(title, `${"y".repeat(78)}\u{1F600}…`);
    assert.doesNotMatch(title, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    closeRow(row);
  });

  it("a title's control characters are shown as plain text, never passed through", async () => {
    const b = newBlock("ctl");
    const row = insertRow({ ...b, name: "ctl" });
    const c = await client();
    setStatus(b.block, [ROOT, child("c1", "red\u001b[31m text\nnext"), child("c2-only-controls", "\u001b\u0007\n\t")]);
    const { subagents } = await c.call("agent_status", { name: "ctl" });
    assert.equal(subagents.titles.length, 2);
    assert.doesNotMatch(subagents.titles[0], /[\u0000-\u001f\u007f]/);
    assert.match(subagents.titles[0], /red.*text.*next/);
    assert.equal(subagents.titles[1], "c2-only-controls", "a title of only control characters falls back to the id");
    closeRow(row);
  });
});

describe("Rex subagent display in hive status", () => {
  it("hive status lists a Rex worker's live subagents and adds no line for a tmux worker or a Rex worker with none", async () => {
    const dir = mkdtempSync(join(dirs.tmp, "status-"));
    const pid = db.prepare("INSERT INTO projects (name, path) VALUES ('rexstatusview', ?) RETURNING id").get(dir).id;
    const busy = newBlock("busy");
    const quiet = newBlock("quiet");
    const rows = [
      insertRow({ ...busy, name: "busy", project: pid, cwd: dir }),
      insertRow({ ...quiet, name: "quiet", project: pid, cwd: dir }),
      insertRow({ ...tmuxPane("cli"), name: "tmuxonly", project: pid, cwd: dir }),
    ];
    setStatus(busy.block, [ROOT, SUBAGENT, SHELL]);
    setStatus(quiet.block, [ROOT]);
    const result = await runCli(["status"], { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp, env: fake.env });
    assert.equal(result.code, 0, result.stderr);
    const all = result.stdout.split("\n");
    const start = all.findIndex((l) => l.startsWith("rexstatusview "));
    assert.ok(start >= 0, result.stdout);
    const end = all.findIndex((l, i) => i > start && l === "");
    const lines = all.slice(start, end === -1 ? undefined : end);
    const after = (name) => {
      const at = lines.findIndex((l) => new RegExp(`^  agent  ${name}\\b`).test(l));
      assert.ok(at >= 0, `hive status lists ${name}:\n${result.stdout}`);
      return lines[at + 1] ?? "";
    };
    assert.match(after("busy"), /^ {9}2 subagents: review the parser; Run the build in background$/);
    assert.doesNotMatch(after("quiet"), /subagents/);
    assert.doesNotMatch(after("tmuxonly"), /subagents/);
    assert.equal(lines.filter((l) => /subagents?:/.test(l)).length, 1, result.stdout);
    for (const row of rows) closeRow(row);
  });
});

describe("Rex subagent display on the dashboard", () => {
  it("the dashboard shows a Rex worker's subagent titles HTML-escaped, from the tick's own snapshot", async () => {
    const dir = mkdtempSync(join(dirs.tmp, "dash-"));
    writeFileSync(join(dir, "hive.yml"), "dashboard: true\n");
    const pid = db.prepare("INSERT INTO projects (name, path) VALUES ('rexdash', ?) RETURNING id").get(dir).id;
    const b = newBlock("dash");
    const row = insertRow({ ...b, name: "dashworker", project: pid, cwd: dir });
    const tmuxRow = insertRow({ ...tmuxPane("dash"), name: "dashtmux", project: pid, cwd: dir });
    setStatus(b.block, [ROOT, child("d1", "<script>alert(1)</script> & co")]);
    const snapshot = terminal.liveTargets();
    const mark = realCalls().length;
    await tick(snapshot);
    const html = readFileSync(join(dir, ".hive", "dashboard.html"), "utf8");
    assert.match(html, /1 subagent: &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; co/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /dashtmux/, "the tmux worker is on the dashboard");
    assert.equal((html.match(/subagent/g) ?? []).length, 1, "only the Rex worker carries a subagent label");
    const snapshots = realCalls().slice(mark).filter((cl) => cl.argv.join(" ").includes("hive:snapshot v1"));
    assert.equal(snapshots.length, 0, "a tick handed its snapshot takes no second one for the dashboard");
    closeRow(row);
    closeRow(tmuxRow);
  });
});
