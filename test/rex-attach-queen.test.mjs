import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { REPO, clearHiveEnv, isolateTmux, leadRow, McpClient, paneField, recordingTmux, resolvedTmuxSocket, runCli, scratchDirs, tmux, tmuxCallsIn, until } from "./helpers.mjs";
import { fakeRexDo, isolateRex } from "./rex-helpers.mjs";

const { hasTmux, cleanup: cleanupTmux } = isolateTmux("rex attach and queen tests");
const dirs = scratchDirs();
clearHiveEnv();
const fake = isolateRex(dirs.tmp);
process.env.HIVE_DATA_DIR = dirs.dataDir;
const rexEnv = fake.childEnv;

const { db, migrate } = await import("../dist/db.js");
if (!db.name.startsWith(dirs.dataDir)) throw new Error(`refusing: opened ${db.name}`);
migrate();
const { rexApi } = await import("../dist/rexCli.js");
const { sessionName } = await import("../dist/tmux.js");

const QUEEN_SESSIONS = ["rexq-alpha", "rexq-queen"];
after(() => {
  fake.cleanup();
  for (const name of QUEEN_SESSIONS) {
    try {
      tmux("kill-session", "-t", `=${name}`);
    } catch {}
  }
  cleanupTmux(sessionName());
});

const READY = join(REPO, "test", "fixtures", "panes", "ready-idle.txt");
const bin = join(dirs.tmp, "claude-bin");
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "claude"), ["#!/bin/sh", `cat '${READY}'`, 'exec cat >> "$PWD/received.txt"', ""].join("\n"));
chmodSync(join(bin, "claude"), 0o755);
const withClaude = (env = {}) => ({ ...rexEnv, PATH: `${bin}:${rexEnv.PATH}`, ...env });

function freshProject(name, yml = "dashboard: false\n") {
  const dir = realpathSync(mkdtempSync(join(dirname(dirs.projectDir), `${name}-`)));
  writeFileSync(join(dir, "hive.yml"), yml);
  return dir;
}

const projectOf = (dir) => db.prepare("SELECT id, name, path FROM projects WHERE path = ?").get(dir);
const cli = (args, dir, env = {}) => runCli(args, { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp, env: withClaude(env) });

async function rexLead(name) {
  const dir = freshProject(name);
  const started = await cli(["lead", dir, "--detach"], dir, { HIVE_TERMINAL: "rex" });
  assert.equal(started.code, 0, started.stdout + started.stderr);
  const project = projectOf(dir);
  const lead = leadRow(db, project.id);
  assert.match(lead.tmux_target, /^block:/);
  return { dir, project, lead, block: fake.state().blocks[lead.tmux_target], started };
}

const apiCallsSince = (mark) =>
  fake.calls().slice(mark).filter((c) => c.argv[0] !== "__fake").map((c) => {
    const i = c.argv.indexOf("call");
    return i >= 0 ? { method: c.argv[i + 1], params: JSON.parse(c.argv[i + 2] ?? "{}") } : { method: c.argv.find((a) => !a.startsWith("-") && !/^\d/.test(a)), argv: c.argv };
  });
const FOCUS_METHODS = new Set(["session.focus_block", "client.list", "client.perform"]);
const APP = { client_id: "client:fake-app", principal: { kind: "peer", transport: "unix", display: "fake-user" }, connected_at: "2026-01-01T00:00:00Z", info: { kind: "app", name: "Rex.app" } };
const CLI_CLIENT = { ...APP, client_id: "client:fake-cli", info: { kind: "cli", name: "rex" } };
const LOST_APP = { ...APP, client_id: "client:fake-lost-app", connection_state: "lost", connection_lost_at: "2026-01-01T00:00:01Z" };
const SWITCHED = "- focused the lead: ";
const NOT_SWITCHED = "no Rex app switched to it";
const TMUX_ATTACH = "Attach from a terminal with: tmux";

async function tmuxLeadUnderRex(name) {
  const dir = freshProject(name, "dashboard: false\nterminal: rex\n");
  const started = await cli(["lead", dir, "--detach"], dir, { HIVE_TERMINAL: "tmux" });
  assert.equal(started.code, 0, started.stdout + started.stderr);
  const project = projectOf(dir);
  const lead = leadRow(db, project.id);
  assert.match(lead.tmux_target, /^%/);
  return { dir, project, lead };
}

function labelsOf(block) {
  const state = fake.state();
  const session = state.sessions.find((s) => s.session_id === block.session_id);
  const window = state.windows.find((w) => w.window_id === state.blocks[block.block_id].window_id);
  return { session: session.label, tab: window.label };
}

describe("Rex attach and focus", () => {
  it("hive attach on Rex focuses the lead and selects its session", async () => {
    const { dir, lead, block } = await rexLead("attach-select");
    fakeRexDo(dirs.tmp, "setClients", { clients: [CLI_CLIENT, LOST_APP, APP] });
    const performedBefore = fake.state().performed.length;
    const mark = fake.calls().length;
    const attached = await cli(["attach", dir], dir);
    assert.equal(attached.code, 0, attached.stdout + attached.stderr);
    const calls = apiCallsSince(mark).filter((c) => FOCUS_METHODS.has(c.method));
    assert.deepEqual(calls.map((c) => c.method), ["session.focus_block", "client.list", "client.perform"]);
    assert.deepEqual(calls[0].params, { session_id: block.session_id, block_id: lead.tmux_target });
    assert.equal(calls[2].params.client_id, APP.client_id);
    assert.equal(calls[2].params.action, "session.select");
    assert.equal(calls[2].params.args.session_id, block.session_id);
    const state = fake.state();
    assert.equal(state.windows.find((w) => w.window_id === state.blocks[lead.tmux_target].window_id).focused_block_id, lead.tmux_target);
    assert.deepEqual(state.performed.slice(performedBefore).map((p) => [p.client_id, p.action, p.args.session_id]), [[APP.client_id, "session.select", block.session_id]]);
    assert.doesNotMatch(attached.stdout, /tmux/);
    assert.ok(attached.stdout.includes(SWITCHED), attached.stdout);
    assert.equal(attached.stdout.includes(NOT_SWITCHED), false, attached.stdout);
    fakeRexDo(dirs.tmp, "setClients", { clients: [] });
  });

  it("hive attach with no Rex client prints the session and tab and exits 0", async () => {
    const { dir, lead, block } = await rexLead("attach-noclient");
    fakeRexDo(dirs.tmp, "setClients", { clients: [APP], perform_error: "not_found" });
    try {
      const mark = fake.calls().length;
      const attached = await cli(["attach", dir], dir);
      assert.equal(attached.code, 0, attached.stdout + attached.stderr);
      const { session, tab } = labelsOf(block);
      assert.ok(session && tab, "the fake must label both the session and the tab");
      assert.ok(attached.stdout.includes(`Rex session ${session}, tab ${tab}`), attached.stdout);
      const methods = apiCallsSince(mark).map((c) => c.method);
      assert.ok(methods.includes("session.focus_block"), methods.join(","));
      assert.ok(methods.includes("client.perform"), methods.join(","));
      assert.ok(attached.stdout.includes(NOT_SWITCHED), attached.stdout);
      assert.equal(attached.stdout.includes(SWITCHED), false, attached.stdout);
      const state = fake.state();
      assert.equal(state.windows.find((w) => w.window_id === state.blocks[lead.tmux_target].window_id).focused_block_id, lead.tmux_target);
    } finally {
      fakeRexDo(dirs.tmp, "setClients", { clients: [] });
    }
  });

  it("hive lead --detach on Rex prints LEAD_PANE=block: and focuses nothing", async () => {
    fakeRexDo(dirs.tmp, "setClients", { clients: [APP] });
    try {
      const mark = fake.calls().length;
      const { dir, lead, started } = await rexLead("detach-nofocus");
      assert.match(started.stdout, new RegExp(`^LEAD_PANE=${lead.tmux_target}$`, "m"));
      assert.match(started.stdout, /^LEAD_PANE=block:/m);
      assert.ok(started.stdout.includes(`ATTACH_COMMAND=hive attach ${dir}`), started.stdout);
      const methods = apiCallsSince(mark).map((c) => c.method);
      assert.ok(methods.includes("session.new_window") || methods.includes("session.new_split") || methods.includes("session.create"), methods.join(","));
      assert.deepEqual(methods.filter((m) => FOCUS_METHODS.has(m)), []);
    } finally {
      fakeRexDo(dirs.tmp, "setClients", { clients: [] });
    }
  });

  it("hive next picks and focuses a Rex project's lead", async () => {
    const dir = freshProject("next-rex", "dashboard: false\nterminal: rex\n");
    const project = db.prepare("INSERT INTO projects (name, path) VALUES ('next-rex', ?) RETURNING id, name, path").get(dir);
    db.prepare("INSERT INTO todos (project_id, title, tags) VALUES (?, 'call me', ?)").run(project.id, JSON.stringify(["needs-human"]));
    fakeRexDo(dirs.tmp, "setClients", { clients: [APP] });
    try {
      const mark = fake.calls().length;
      const next = await cli(["next"], dir);
      assert.equal(next.code, 0, next.stdout + next.stderr);
      assert.equal(JSON.parse(next.stdout.trim().split("\n")[0]).project_id, project.id);
      const lead = leadRow(db, project.id);
      assert.match(lead.tmux_target, /^block:/);
      const session = fake.state().blocks[lead.tmux_target].session_id;
      const calls = apiCallsSince(mark).filter((c) => FOCUS_METHODS.has(c.method));
      assert.deepEqual(calls.map((c) => c.method), ["session.focus_block", "client.list", "client.perform"]);
      assert.deepEqual(calls[0].params, { session_id: session, block_id: lead.tmux_target });
      assert.equal(calls[2].params.args.session_id, session);
    } finally {
      fakeRexDo(dirs.tmp, "setClients", { clients: [] });
    }
  });
});

describe("attach follows the live lead's own terminal", () => {
  const tmuxIt = (name, fn) => it(name, { skip: hasTmux ? false : "tmux is not installed" }, fn);

  tmuxIt("hive attach on a live tmux lead under terminal: rex takes the tmux attach path", async () => {
    const { dir } = await tmuxLeadUnderRex("attach-tmux-under-rex");
    const mark = fake.calls().length;
    const attached = await cli(["attach", dir], dir);
    assert.equal(attached.code, 0, attached.stdout + attached.stderr);
    assert.ok(attached.stdout.includes(TMUX_ATTACH), attached.stdout + attached.stderr);
    assert.deepEqual(apiCallsSince(mark).filter((c) => FOCUS_METHODS.has(c.method)), []);
  });

  tmuxIt("hive next under terminal: rex adopts and attaches a live tmux lead", async () => {
    const { dir, project, lead } = await tmuxLeadUnderRex("next-tmux-under-rex");
    for (let i = 0; i < 3; i++) db.prepare("INSERT INTO todos (project_id, title, tags) VALUES (?, 'call me', ?)").run(project.id, JSON.stringify(["needs-human"]));
    const mark = fake.calls().length;
    const next = await cli(["next"], dir);
    assert.equal(next.code, 0, next.stdout + next.stderr);
    assert.equal(JSON.parse(next.stdout.trim().split("\n")[0]).project_id, project.id);
    assert.equal(leadRow(db, project.id).tmux_target, lead.tmux_target);
    assert.ok(next.stdout.includes(TMUX_ATTACH), next.stdout + next.stderr);
    assert.deepEqual(apiCallsSince(mark).filter((c) => FOCUS_METHODS.has(c.method)), []);
  });

  tmuxIt("hive attach on a project set to tmux with a closed Rex lead block falls through to the tmux path", async () => {
    const { dir, lead } = await rexLead("attach-stale-rex");
    fakeRexDo(dirs.tmp, "closeBlock", { block_id: lead.tmux_target });
    const mark = fake.calls().length;
    const attached = await cli(["attach", dir], dir);
    assert.equal(attached.code, 0, attached.stdout + attached.stderr);
    assert.ok(attached.stdout.includes(TMUX_ATTACH), attached.stdout + attached.stderr);
    assert.deepEqual(apiCallsSince(mark).filter((c) => FOCUS_METHODS.has(c.method)), []);
  });

  it("hive attach still selects and names the session id when session.view fails after focusing", async () => {
    const { dir, lead, block } = await rexLead("attach-view-fails");
    fakeRexDo(dirs.tmp, "setClients", { clients: [APP] });
    try {
      const performedBefore = fake.state().performed.length;
      const attached = await cli(["attach", dir], dir, { FAKE_REX_FAIL_ON: "session.view" });
      assert.equal(attached.code, 0, attached.stdout + attached.stderr);
      assert.ok(attached.stdout.includes(`${SWITCHED}Rex session ${block.session_id}, tab (unknown)`), attached.stdout + attached.stderr);
      const state = fake.state();
      assert.equal(state.windows.find((w) => w.window_id === state.blocks[lead.tmux_target].window_id).focused_block_id, lead.tmux_target);
      assert.deepEqual(state.performed.slice(performedBefore).map((p) => [p.client_id, p.args]), [[APP.client_id, { session_id: block.session_id }]]);
    } finally {
      fakeRexDo(dirs.tmp, "setClients", { clients: [] });
    }
  });
});

describe("the queen across terminals", () => {
  it("a Rex queen delivers agent_send to a tmux lead and a tmux queen to a Rex lead", { skip: hasTmux ? false : "tmux is not installed" }, async () => {
    const socket = resolvedTmuxSocket();
    const queenHome = join(dirs.dataDir, "queen");
    mkdirSync(queenHome, { recursive: true });
    const queen = db.prepare("INSERT INTO projects (name, path) VALUES ('queen', ?) RETURNING id").get(realpathSync(queenHome)).id;

    const alphaDir = freshProject("qx-alpha");
    const alpha = db.prepare("INSERT INTO projects (name, path) VALUES ('qx-alpha', ?) RETURNING id").get(alphaDir).id;
    const alphaPane = tmux("new-session", "-d", "-s", "rexq-alpha", "-c", alphaDir, "-P", "-F", "#{pane_id}", join(bin, "claude"));
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, command, cwd, kind, status, tmux_target, tmux_socket, pane_pid)
       VALUES (?, 'lead:alpha', 'lead', 'claude', ?, 'lead', 'running', ?, ?, ?)`,
    ).run(alpha, alphaDir, alphaPane, socket, paneField(alphaPane, "#{pane_pid}"));

    const beta = await rexLead("qx-beta");

    const queenRow = db
      .prepare(
        `INSERT INTO agents (project_id, name, command, cwd, kind, status, tmux_target, tmux_socket)
         VALUES (?, 'lead', 'claude', ?, 'lead', 'running', '', '') RETURNING id`,
      )
      .get(queen, queenHome).id;
    db.prepare("UPDATE agents SET actor_id = ? WHERE id = ?").run(`lead:${queenRow}`, queenRow);
    db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES (?, 'lead', 'lead')").run(`lead:${queenRow}`);

    const queenSession = rexApi(process.env.REX_SERVER, "session.create", {
      label: "queen-home",
      initial_windows: [{ window_label: "queen", layout: { block: { options: { command: ["/bin/sleep", "600"], shell: "none", login: false } } } }],
    });
    const queenBlock = queenSession.initial_windows[0].block_ids[0];
    const queenPane = tmux("new-session", "-d", "-s", "rexq-queen", "-P", "-F", "#{pane_id}", "sleep", "600");

    const tmuxLog = join(mkdtempSync(join(tmpdir(), "hive-rexq-")), "tmux.log");
    const recDir = recordingTmux({ log: tmuxLog });
    const received = (dir) => (existsSync(join(dir, "received.txt")) ? readFileSync(join(dir, "received.txt"), "utf8") : "");

    async function sendAs(env, project, text) {
      const mcp = new McpClient({ cwd: queenHome, dataDir: dirs.dataDir, env: { ...env, HIVE_AGENT_ID: `lead:${queenRow}`, HIVE_LEAD: "1" } });
      await mcp.start();
      try {
        const rexMark = fake.calls().length;
        const tmuxMark = tmuxCallsIn(tmuxLog).length;
        const sent = await mcp.call("agent_send", { name: "lead", text, project_id: project });
        assert.ok(sent, `agent_send to project ${project} returned no receipt`);
        return { sent, rexCalls: () => apiCallsSince(rexMark), tmuxCalls: () => tmuxCallsIn(tmuxLog).slice(tmuxMark) };
      } finally {
        await mcp.close();
      }
    }

    const { TMUX: _t, TMUX_PANE: _p, ...rexCaller } = rexEnv;
    db.prepare("UPDATE agents SET tmux_target = ?, tmux_socket = ? WHERE id = ?").run(queenBlock, `rex:${process.env.REX_SERVER}`, queenRow);
    const toTmux = await sendAs({ ...rexCaller, PATH: `${recDir}:${rexEnv.PATH}`, REX_BLOCK: queenBlock, REX_SESSION: queenSession.session_id }, alpha, "from the rex queen");
    await until(() => received(alphaDir).includes("from the rex queen"), 5000, 25, "the tmux lead never received the Rex queen's message");
    assert.ok(toTmux.tmuxCalls().some((argv) => argv.includes("paste-buffer") && argv.includes(alphaPane)), JSON.stringify(toTmux.tmuxCalls()));
    assert.deepEqual(toTmux.tmuxCalls().filter((argv) => argv.some((a) => a.includes("block:"))), []);
    assert.deepEqual(toTmux.rexCalls().filter((c) => c.method === "block.event" || c.method === "send-key" || JSON.stringify(c).includes(alphaPane)), []);
    assert.equal(received(beta.dir).includes("from the rex queen"), false);

    const { REX_BLOCK: _b, REX_SESSION: _s, REX_SERVER: _v, ...tmuxCaller } = rexEnv;
    db.prepare("UPDATE agents SET tmux_target = ?, tmux_socket = ?, pane_pid = ? WHERE id = ?").run(queenPane, socket, paneField(queenPane, "#{pane_pid}"), queenRow);
    const toRex = await sendAs({ ...tmuxCaller, PATH: `${recDir}:${rexEnv.PATH}`, TMUX: `${socket},1,0`, TMUX_PANE: queenPane }, beta.project.id, "from the tmux queen");
    await until(() => received(beta.dir).includes("from the tmux queen"), 5000, 25, "the Rex lead never received the tmux queen's message");
    assert.ok(toRex.rexCalls().some((c) => c.method === "block.event" && c.params.block_id === beta.lead.tmux_target && c.params.event?.type === "paste"), JSON.stringify(toRex.rexCalls()));
    assert.deepEqual(toRex.tmuxCalls().filter((argv) => argv.some((a) => ["paste-buffer", "load-buffer", "set-buffer", "send-keys"].includes(a)) || argv.some((a) => a.includes("block:"))), []);
    assert.equal(received(alphaDir).includes("from the tmux queen"), false);
  });
});
