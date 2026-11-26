import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DIST, McpClient, clearHiveEnv, isolateTmux, runCli, runNode, scratchDirs } from "./helpers.mjs";
import { fakeRexDo, isolateRex, waitFor } from "./rex-helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("rex review fixes tests");
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
const { janitor } = await import("../dist/scheduler.js");
const { rexApi } = await import("../dist/rexCli.js");
const { REX_IN_USE_KEY } = await import("../dist/terminal/rex.js");

const HOOK = join(DIST, "hook.js");
const BIN = join(dirs.tmp, "bin");
mkdirSync(BIN, { recursive: true });
writeFileSync(join(BIN, "claude"), "#!/bin/sh\nexec sleep 600\n");
chmodSync(join(BIN, "claude"), 0o755);
const CLAUDE = join(BIN, "claude");
const BLOCKED = [{ state: "blocked", kind: "permission", app: "claude", msg: "approve Bash: ls" }];
const IDLE = [{ state: "idle", app: "claude" }];
const NO_SCHEDULER = { HIVE_SCHEDULER_INTERVAL_MS: "2147483647" };

let projectId;
let projectDir;
let seq = 0;
const clients = [];

before(() => {
  projectDir = mkdtempSync(join(dirs.tmp, "rex-fixes-"));
  writeFileSync(join(projectDir, "hive.yml"), "dashboard: false\n");
  projectId = db.prepare("INSERT INTO projects (name, path) VALUES ('rexfixes', ?) RETURNING id").get(projectDir).id;
  db.prepare("INSERT INTO kv (project_id, key, value, updated_by) VALUES (?, ?, '1', 'test')").run(projectId, REX_IN_USE_KEY);
});

after(async () => {
  for (const client of clients) await client.close().catch(() => {});
  fake.cleanup();
  cleanupTmux();
  db.close();
});

const pastes = (block) => (fake.state().blocks[block]?.events ?? []).filter((e) => e.type === "paste");
const setStatus = (block, records) => fakeRexDo(dirs.tmp, "setProgramStatus", { block_id: block, records });
const rowById = (id) => db.prepare("SELECT * FROM agents WHERE id = ?").get(id);

function newBlock(label) {
  const made = rexApi(REX_ADDR, "session.create", {
    label: `s-${label}-${++seq}`,
    initial_windows: [{ window_label: label, layout: { block: { flavor: "com.superlogical.terminal.shell", label, options: { shell: "none", login: false, command: [CLAUDE] } } } }],
  });
  const block = made.initial_windows[0].block_ids[0];
  return { block, pid: String(fake.state().blocks[block].child_pid) };
}

function insertRow({ block, pid, kind = "agent", name = `w${++seq}`, project = projectId }) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, pane_pid, command, cwd, kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'claude', ?, ?, 'running', datetime('now', '-10 minutes')) RETURNING *`,
    )
    .get(project, `${kind}:${name}`, name, block, SOCKET, pid, projectDir, kind);
}

const closeRow = (row) => db.prepare("UPDATE agents SET status = 'closed' WHERE id = ?").run(row.id);

describe("a Rex lead's SessionStart hook registers its Claude messaging socket", () => {
  it("records the socket and the lead block's pid from REX_BLOCK, with no TMUX_PANE at all", async () => {
    const b = newBlock("lead-socket");
    const lead = insertRow({ ...b, kind: "lead", name: "lead" });
    const { code, stderr } = await runNode(HOOK, ["session_start"], {
      dataDir: dirs.dataDir,
      env: { ...fake.env, HIVE_AGENT_ID: lead.actor_id, HIVE_LEAD: "1", REX_BLOCK: b.block, CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/rex-lead-claude.sock" },
      stdin: JSON.stringify({ hook_event_name: "SessionStart", session_id: "rex-s1", source: "startup" }),
    });
    assert.equal(code, 0, stderr);
    const row = rowById(lead.id);
    assert.equal(row.claude_messaging_socket, "/tmp/rex-lead-claude.sock");
    assert.equal(row.claude_messaging_pane_pid, b.pid);
    closeRow(lead);
  });
});

describe("agent_send's text path holds on a Rex program status", () => {
  async function client() {
    const c = new McpClient({ cwd: projectDir, dataDir: dirs.dataDir, env: { ...fake.env, ...NO_SCHEDULER } });
    await c.start();
    clients.push(c);
    return c;
  }

  it("a blocked permission status refuses text, submitted or not, and pastes nothing; idle lets the same send through", async () => {
    const b = newBlock("perm");
    const row = insertRow({ ...b, name: "perm" });
    const c = await client();
    setStatus(b.block, BLOCKED);
    assert.equal(terminal.paneAwaitingChoice(b.block), false, "the screen shows no dialog");
    for (const submit of [true, false]) {
      const refused = await c.call("agent_send", { name: "perm", text: "go ahead", submit });
      assert.equal(refused.sent, false, JSON.stringify(refused));
      assert.match(refused.note, /waiting on a choice/);
    }
    assert.deepEqual(pastes(b.block), []);

    setStatus(b.block, IDLE);
    const sent = await c.call("agent_send", { name: "perm", text: "go ahead" });
    assert.equal(sent.sent, true, JSON.stringify(sent));
    await waitFor(() => pastes(b.block).length === 1);
    assert.match(pastes(b.block)[0].payload.text, /go ahead/);
    closeRow(row);
  });
});

describe("the janitor's close path for a Rex worker", () => {
  it("a Rex worker whose block closed is marked lost for crew-restore even when tmux never answered", () => {
    const b = newBlock("lost");
    const row = insertRow({ ...b, name: "lost" });
    fakeRexDo(dirs.tmp, "closeBlock", { block_id: b.block });
    const snapshot = terminal.liveTargets();
    snapshot.serverAnswered = false;
    janitor(snapshot);
    const after = rowById(row.id);
    assert.equal(after.status, "closed");
    assert.equal(after.recovery_state, "pending");
  });
});

describe("the terminal:rex:in-use flag", () => {
  const flagOf = (project) => db.prepare("SELECT * FROM kv WHERE project_id = ? AND key = ?").get(project, REX_IN_USE_KEY);
  function project(name, age) {
    const id = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, mkdtempSync(join(dirs.tmp, `${name}-`))).id;
    db.prepare(`INSERT INTO kv (project_id, key, value, updated_by, updated_at) VALUES (?, ?, '1', 'hive', datetime('now', ?))`).run(id, REX_IN_USE_KEY, age);
    return id;
  }

  it("is cleared by the janitor once it is stale and its project has no running Rex row and no pending reap", () => {
    const idle = project("flag-idle", "-20 minutes");
    const fresh = project("flag-fresh", "-0 seconds");
    const busy = project("flag-busy", "-20 minutes");
    const reaping = project("flag-reaping", "-20 minutes");
    const b = newBlock("flag-busy");
    const row = insertRow({ ...b, name: "flag-busy", project: busy });
    db.prepare("INSERT INTO kv (project_id, key, value, updated_by) VALUES (?, 'terminal:rex:reap:agent:none', 'not json', 'hive')").run(reaping);
    assert.ok(flagOf(idle));
    janitor();
    assert.equal(flagOf(idle), undefined, "a stale flag with nothing on Rex is cleared");
    assert.ok(flagOf(fresh), "a flag written within the window survives a spawn that has not recorded its row yet");
    assert.ok(flagOf(busy), "a running Rex row keeps its project's flag");
    assert.ok(flagOf(reaping), "a pending reap keeps its project's flag");
    closeRow(row);
  });
});

describe("output for a user who never chose Rex", () => {
  const plainEnv = () => Object.fromEntries(Object.entries(fake.env).filter(([k]) => !k.startsWith("HIVE_")));
  const own = () => {
    const d = scratchDirs();
    return { d, opts: (env = {}) => ({ cwd: d.projectDir, dataDir: d.dataDir, tmp: d.tmp, env: { ...plainEnv(), HIVE_NO_UPDATE_CHECK: "1", ...env } }) };
  };
  const REX_USAGE = [/hive peek/, /--terminal/, /Rex only/, /# terminal:/, /# workers:/, /wait_for_port/];

  it("hive --help names no Rex command or key, and does once HIVE_TERMINAL=rex", async () => {
    const { opts } = own();
    const plain = await runCli(["--help"], opts());
    for (const re of REX_USAGE) assert.doesNotMatch(plain.stdout, re);
    const rex = await runCli(["--help"], opts({ HIVE_TERMINAL: "rex" }));
    for (const re of REX_USAGE) assert.match(rex.stdout, re);
  });

  it("hive init writes a hive.yml with no terminal, workers or wait_for_port lines, and with them once Rex is chosen", async () => {
    const plain = own();
    assert.equal((await runCli(["init", "--no-profile"], plain.opts())).code, 0);
    const text = readFileSync(join(plain.d.projectDir, "hive.yml"), "utf8");
    assert.match(text, /# lead: claude --model opus/);
    for (const re of [/terminal:/, /workers:/, /wait_for_port/]) assert.doesNotMatch(text, re);
    const rex = own();
    assert.equal((await runCli(["init", "--no-profile"], rex.opts({ HIVE_TERMINAL: "rex" }))).code, 0);
    const rexText = readFileSync(join(rex.d.projectDir, "hive.yml"), "utf8");
    for (const re of [/# terminal: tmux/, /# workers: shown/, /wait_for_port: 3000/]) assert.match(rexText, re);
  });

  it("hive setup prints no terminal line and lists no --terminal flag unless Rex or a terminal was chosen", async () => {
    const { d, opts } = own();
    const plain = await runCli(["setup", "--dir", join(d.tmp, "bin"), "--force"], opts());
    assert.equal(plain.code, 0, plain.stdout + plain.stderr);
    assert.match(plain.stdout, /auto-attach {2}/);
    assert.doesNotMatch(plain.stdout, /^terminal /m);
    const unknown = await runCli(["setup", "--bogus"], opts());
    assert.match(unknown.stderr, /Flags are --dir, --attach, --auto-attach, --force\.$/m);
    const chosen = await runCli(["setup", "--dir", join(d.tmp, "bin"), "--terminal", "tmux", "--force"], opts());
    assert.match(chosen.stdout, /^terminal {5}tmux \(source: global\)/m);
  });

  it("doctor reports no config terminal or config workers row unless Rex or a terminal was chosen", async () => {
    const { opts } = own();
    assert.equal((await runCli(["init", "--no-profile"], opts())).code, 0);
    const plain = (await runCli(["doctor"], opts())).stdout;
    assert.match(plain, /info {2}config layout:/);
    assert.doesNotMatch(plain, /config terminal|config workers/);
    const rex = (await runCli(["doctor"], opts({ HIVE_TERMINAL: "rex" }))).stdout;
    assert.match(rex, /info {2}config terminal: "rex" \(source: env\)/);
    assert.match(rex, /info {2}config workers:/);
  });

  it("help(topic=layout) is upstream's text with no Rex section, and carries it once HIVE_TERMINAL=rex", async () => {
    const topic = async (env) => {
      const { d } = own();
      const c = new McpClient({ cwd: d.projectDir, dataDir: d.dataDir, env: { ...plainEnv(), ...NO_SCHEDULER, ...env } });
      await c.start();
      clients.push(c);
      const msg = await c.request("tools/call", { name: "help", arguments: { topic: "layout" } });
      return msg.result.content[0].text;
    };
    const plain = await topic({});
    assert.match(plain, /This is a CLI command for the local tmux environment, not an MCP tool\.$/);
    assert.doesNotMatch(plain, /Rex/);
    assert.match(await topic({ HIVE_TERMINAL: "rex" }), /Hiding, showing and peeking at workers \(Rex only\)/);
  });
});
