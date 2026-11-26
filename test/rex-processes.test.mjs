import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, leadRow, makeFakeClaude, McpClient, runCli, scratchDirs, seedTrustedYml } from "./helpers.mjs";
import { isolateRex, waitFor } from "./rex-helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("rex processes and layout tests");
const dirs = scratchDirs();
const fake = isolateRex(dirs.tmp);
clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const REX_ADDR = process.env.REX_SERVER;
const SOCKET = `rex:${REX_ADDR}`;
const rexEnv = Object.fromEntries(Object.entries(fake.env).filter(([k]) => !k.startsWith("HIVE_")));

const { db, migrate } = await import("../dist/db.js");
migrate();
await import("../dist/rexInUse.js");
const { janitor } = await import("../dist/scheduler.js");
const { rexApi } = await import("../dist/rexCli.js");
const { rexFloatHidden, rexLayoutPlan, rexUnfloat } = await import("../dist/terminal/rex.js");

const clients = [];
after(async () => {
  for (const client of clients) await client.close();
  fake.cleanup();
  cleanupTmux();
});

const fakeClaude = makeFakeClaude(dirs.tmp);
const CLAUDE = fakeClaude("sleep 600");
const withClaude = (env = {}) => ({ ...rexEnv, PATH: `${dirname(CLAUDE)}:${rexEnv.PATH}`, ...env });

const realCalls = () => fake.calls().filter((c) => c.argv[0] !== "__fake");
const apiCalls = (since = 0) =>
  realCalls()
    .slice(since)
    .map((c) => {
      const i = c.argv.indexOf("call");
      if (i >= 0) return { method: c.argv[i + 1], params: JSON.parse(c.argv[i + 2] ?? "{}") };
      const k = c.argv.indexOf("send-key");
      return k >= 0 ? { method: "send-key", params: { keys: c.argv.slice(k + 1) } } : null;
    })
    .filter(Boolean);
const methods = (calls) => calls.map((c) => c.method);

function freshProject(name) {
  return mkdtempSync(join(dirname(dirs.projectDir), `${name}-`));
}

const projectOf = (dir) => db.prepare("SELECT id, name, path FROM projects WHERE path = ?").get(dir);
const cli = (args, dir, env = {}) => runCli(args, { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp, env: withClaude(env) });

async function startLead(dir) {
  const result = await cli(["lead", dir, "--detach"], dir, { HIVE_TERMINAL: "rex" });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const project = projectOf(dir);
  return { project, lead: leadRow(db, project.id) };
}

const processRow = (projectId, name) =>
  db.prepare("SELECT * FROM agents WHERE project_id = ? AND name = ? AND kind = 'command' ORDER BY id DESC LIMIT 1").get(projectId, name);

function view(block) {
  const state = fake.state();
  const session = state.blocks[block].session_id;
  return rexApi(REX_ADDR, "session.view", { session_id: session });
}

function rectOf(node, block) {
  if (!node) return null;
  if (node.block_id === block) return node.rect;
  return node.split ? rectOf(node.split.before, block) ?? rectOf(node.split.after, block) : null;
}

function locate(block) {
  for (const window of view(block).windows) {
    for (const layer of window.layers) {
      if (layer.blocks.some((b) => b.block_id === block)) return { window, layer, rect: rectOf(layer.layout, block) };
    }
  }
  return null;
}

const round = (rect) => rect.map((n) => Math.round(n * 1000) / 1000);

function ignoresInterrupt() {
  const bin = mkdtempSync(join(dirs.tmp, "noint-"));
  const path = join(bin, "noint");
  writeFileSync(path, "#!/bin/sh\ntrap '' INT\nexec sleep 600\n");
  chmodSync(path, 0o755);
  return path;
}

describe("Rex hive.yml processes", () => {
  it("visible:false process is a minimized float in the lead's tab", async () => {
    const dir = freshProject("rex-hidden-proc");
    const { project, lead } = await startLead(dir);
    await seedTrustedYml({ db, projectId: project.id, projectDir: dir, processes: { web: { command: "sleep 600", visible: false } } });
    const before = realCalls().length;
    const started = await cli(["start", "web"], dir);
    assert.equal(started.code, 0, started.stdout + started.stderr);
    assert.match(started.stdout, /web: started \(hidden\)/);
    const row = processRow(project.id, "web");
    assert.match(row.tmux_target, /^block:/);
    assert.equal(row.tmux_socket, SOCKET);
    const where = locate(row.tmux_target);
    const leadAt = locate(lead.tmux_target);
    assert.equal(where.window.window_id, leadAt.window.window_id, "the float is in the lead's tab");
    assert.equal(where.layer.kind, "floating");
    assert.equal(where.layer.state, "minimized");
    assert.deepEqual(round(where.layer.bounds), round(leadAt.rect), "the float is sized to the lead block");
    const calls = apiCalls(before);
    const order = methods(calls).filter((m) => ["session.new_split", "session.float_block", "session.set_layer_state", "session.resize_layer"].includes(m));
    assert.deepEqual(order, ["session.new_split", "session.float_block", "session.set_layer_state", "session.resize_layer"]);
    assert.equal(calls.find((c) => c.method === "session.set_layer_state").params.state, "minimized");
    assert.equal(calls.filter((c) => c.method === "session.new_window").length, 0, "no processes tab is made");
    const status = await cli(["start", "web"], dir);
    assert.match(status.stdout, /web: already running \(hidden\)/);
  });

  it("hive stop on Rex sends ctrl+c, waits, then closes", async () => {
    const dir = freshProject("rex-stop-proc");
    const { project } = await startLead(dir);
    const stubborn = ignoresInterrupt();
    await seedTrustedYml({ db, projectId: project.id, projectDir: dir, processes: { api: "sleep 600", stubborn } });
    assert.equal((await cli(["start", "api"], dir)).code, 0);
    assert.equal((await cli(["start", "stubborn"], dir)).code, 0);
    const api = processRow(project.id, "api");
    const hard = processRow(project.id, "stubborn");

    let before = realCalls().length;
    let started = Date.now();
    const graceful = await cli(["stop", "api"], dir);
    assert.match(graceful.stdout, /api: stopped \(C-c\)/, graceful.stdout + graceful.stderr);
    assert.ok(Date.now() - started < 2000 + 1500, "an interrupted process is not held for the whole grace window");
    assert.ok(apiCalls(before).some((c) => c.method === "send-key" && c.params.keys.includes("ctrl+c")), "the stop interrupts first");
    assert.equal(fake.state().blocks[api.tmux_target], undefined);
    assert.equal(processRow(project.id, "api").status, "closed");

    before = realCalls().length;
    started = Date.now();
    const forced = await cli(["stop", "stubborn"], dir);
    assert.match(forced.stdout, /stubborn: stopped \(killed after 2s\)/, forced.stdout + forced.stderr);
    assert.ok(Date.now() - started >= 2000, "the close waits out the grace window");
    const seq = methods(apiCalls(before));
    const key = apiCalls(before).findIndex((c) => c.method === "send-key" && c.params.keys.includes("ctrl+c"));
    assert.ok(key >= 0, seq.join(","));
    assert.ok(seq.lastIndexOf("block.close") > key, "the close comes after the interrupt");
    assert.equal(fake.state().blocks[hard.tmux_target], undefined, "the block that ignored ctrl+c is closed");
    assert.equal(processRow(project.id, "stubborn").status, "closed");
  });

  it("hive hide floats a shown Rex process and hive show moves it back beside the lead", async () => {
    const dir = freshProject("rex-hide-show");
    const { project, lead } = await startLead(dir);
    await seedTrustedYml({ db, projectId: project.id, projectDir: dir, processes: { web: "sleep 600" } });
    assert.equal((await cli(["start", "web"], dir)).code, 0);
    const row = processRow(project.id, "web");
    assert.equal(locate(row.tmux_target).layer.kind, "tiled");

    const hidden = await cli(["hide", "web"], dir);
    assert.match(hidden.stdout, /web: hidden/, hidden.stdout + hidden.stderr);
    assert.equal(locate(row.tmux_target).layer.state, "minimized");
    assert.match((await cli(["hide", "web"], dir)).stdout, /web: already hidden/);

    const before = realCalls().length;
    const shown = await cli(["show", "web"], dir);
    assert.match(shown.stdout, /web: shown/, shown.stdout + shown.stderr);
    const move = apiCalls(before).find((c) => c.method === "session.move_block");
    assert.equal(move?.params.anchor_block_id, lead.tmux_target);
    const where = locate(row.tmux_target);
    assert.equal(where.layer.kind, "tiled");
    assert.equal(where.window.window_id, locate(lead.tmux_target).window.window_id);
    assert.equal(where.window.layers.length, 1, "the emptied float layer is gone");
    assert.match((await cli(["show", "web"], dir)).stdout, /web: already shown/);
  });

  it("an untrusted hive.yml process under a Rex lead never creates a block", async () => {
    const dir = freshProject("rex-untrusted");
    await startLead(dir);
    writeFileSync(join(dir, "hive.yml"), "processes:\n  web:\n    command: sleep 600\n");
    const before = realCalls().length;
    const blocks = Object.keys(fake.state().blocks).length;
    const result = await cli(["start", "web"], dir);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    const creating = methods(apiCalls(before)).filter((m) => ["session.new_split", "session.new_window", "session.new_block", "session.float_block"].includes(m));
    assert.deepEqual(creating, []);
    assert.equal(Object.keys(fake.state().blocks).length, blocks);
  });

  it("with no Rex configured, hive stop --all makes no rex call", async () => {
    const dir = freshProject("rex-none");
    const plainData = mkdtempSync(join(dirs.tmp, "plain-data-"));
    assert.equal((await runCli(["init", "--no-profile"], { cwd: dir, dataDir: plainData, tmp: dirs.tmp, env: rexEnv })).code, 0);
    const before = realCalls().length;
    const stopped = await runCli(["stop", "--all"], { cwd: dir, dataDir: plainData, tmp: dirs.tmp, env: rexEnv });
    assert.match(stopped.stdout, /No processes are running/);
    assert.deepEqual(realCalls().slice(before), []);
  });
});

describe("Rex floats", () => {
  it("rexUnfloat with placement window opens a tab through a placeholder it then closes", async () => {
    const dir = freshProject("rex-unfloat-window");
    const { project, lead } = await startLead(dir);
    await seedTrustedYml({ db, projectId: project.id, projectDir: dir, processes: { job: { command: "sleep 600", visible: false } } });
    assert.equal((await cli(["start", "job"], dir)).code, 0);
    const row = processRow(project.id, "job");
    const before = realCalls().length;
    const blocksBefore = new Set(Object.keys(fake.state().blocks));
    rexUnfloat(row.tmux_target, lead.tmux_target, "window", `${project.name}/job`);
    const calls = apiCalls(before);
    const seq = methods(calls).filter((m) => ["session.new_window", "session.move_block", "block.close"].includes(m));
    assert.deepEqual(seq, ["session.new_window", "session.move_block", "block.close"]);
    const where = locate(row.tmux_target);
    assert.notEqual(where.window.window_id, locate(lead.tmux_target).window.window_id);
    assert.equal(where.window.label, `${project.name}/job`);
    assert.deepEqual(where.window.layers.map((l) => l.blocks.map((b) => b.block_id)), [[row.tmux_target]], "only the process is left in its new tab");
    assert.deepEqual(Object.keys(fake.state().blocks).filter((id) => !blocksBefore.has(id)), [], "the placeholder block is closed");
    assert.equal(locate(lead.tmux_target).window.layers.length, 1);
  });

  it("rexFloatHidden re-minimizes a float someone restored, without floating it twice", async () => {
    const dir = freshProject("rex-rehide");
    const { project, lead } = await startLead(dir);
    await seedTrustedYml({ db, projectId: project.id, projectDir: dir, processes: { job: { command: "sleep 600", visible: false } } });
    assert.equal((await cli(["start", "job"], dir)).code, 0);
    const row = processRow(project.id, "job");
    const at = locate(row.tmux_target);
    rexApi(REX_ADDR, "session.set_layer_state", { session_id: fake.state().blocks[row.tmux_target].session_id, layer_id: at.layer.layer_id, state: "normal" });
    const before = realCalls().length;
    rexFloatHidden(row.tmux_target, lead.tmux_target);
    assert.equal(locate(row.tmux_target).layer.state, "minimized");
    assert.equal(methods(apiCalls(before)).filter((m) => m === "session.float_block").length, 0);
  });
});

describe("hive layout on Rex", () => {
  it("hive layout on Rex is the only path that resizes", async () => {
    const dir = freshProject("rex-layout");
    const before = realCalls().length;
    const { project, lead } = await startLead(dir);
    const mcp = new McpClient({ cwd: dir, dataDir: dirs.dataDir, env: withClaude({ HIVE_AGENT_ID: lead.actor_id, HIVE_SPAWN_READY_MS: "300" }) });
    clients.push(mcp);
    await mcp.start();
    const one = await mcp.call("agent_spawn", { name: "w-one", command: fakeClaude("sleep 600"), placement: "split" });
    const two = await mcp.call("agent_spawn", { name: "w-two", command: fakeClaude("sleep 600"), placement: "split" });
    const resizing = ["session.resize_pane", "session.resize_layer"];
    assert.deepEqual(methods(apiCalls(before)).filter((m) => resizing.includes(m)), [], "spawning never resizes");

    const mark = realCalls().length;
    const laid = await cli(["layout"], dir);
    assert.equal(laid.code, 0, laid.stdout + laid.stderr);
    assert.ok(methods(apiCalls(mark)).filter((m) => m === "session.resize_pane").length >= 1, methods(apiCalls(mark)).join(","));
    assert.deepEqual(round(locate(lead.tmux_target).rect), [0, 0, 0.5, 0.5]);
    assert.deepEqual(round(locate(one.tmux_target).rect), [0.5, 0, 0.5, 0.5]);
    assert.deepEqual(round(locate(two.tmux_target).rect), [0, 0.5, 1, 0.5]);
    await mcp.close();
    clients.splice(clients.indexOf(mcp), 1);
  });

  it("rexLayoutPlan for main-vertical keeps the lead left and stacks the rest evenly on the right", () => {
    const plan = rexLayoutPlan("L", ["A", "B", "C"], "main-vertical");
    assert.deepEqual(plan.moves, [
      { block: "A", anchor: "L", direction: "horizontal" },
      { block: "B", anchor: "A", direction: "vertical" },
      { block: "C", anchor: "B", direction: "vertical" },
    ]);
    assert.deepEqual(plan.resizes.map((r) => [r.before, r.after, r.direction, Math.round(r.ratio * 1000) / 1000]), [
      ["L", "A", "horizontal", 0.5],
      ["A", "B", "vertical", 0.333],
      ["B", "C", "vertical", 0.5],
    ]);
  });
});

describe("the janitor on Rex", () => {
  it("a block whose program exited is closed after one janitor tick, and its final screen was captured", async () => {
    const projectId = db.prepare("INSERT INTO projects (name, path) VALUES ('rex-janitor', ?) RETURNING id").get(freshProject("rex-janitor")).id;
    const made = rexApi(REX_ADDR, "session.create", {
      label: "s-janitor",
      initial_windows: [{ window_label: "j", layout: { block: { flavor: "com.superlogical.terminal.shell", label: "j", options: { shell: "none", login: false, command: ["/bin/sh", "-c", "sleep 0.3; echo last words here; exit 0"], exit: { on_completion: false } } } } }],
    });
    const block = made.initial_windows[0].block_ids[0];
    const pid = String(fake.state().blocks[block].child_pid);
    const row = db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, pane_pid, command, cwd, kind, status, created_at)
         VALUES (?, 'command:janitor', 'gone-proc', ?, ?, ?, 'sh', ?, 'command', 'running', datetime('now', '-10 minutes')) RETURNING id`,
      )
      .get(projectId, block, SOCKET, pid, dirs.projectDir);
    await waitFor(() => rexApi(REX_ADDR, "block.method", { session_id: made.session_id, block_id: block, method: "process", args: {} }).last_exit != null);
    assert.ok(fake.state().blocks[block], "the exited block is held open before the tick");
    const before = realCalls().length;
    janitor();
    const after = db.prepare("SELECT status, exit_tail FROM agents WHERE id = ?").get(row.id);
    assert.equal(after.status, "closed");
    assert.match(after.exit_tail, /last words here/);
    assert.equal(fake.state().blocks[block], undefined, "the block is closed");
    const mine = apiCalls(before).filter((c) => c.params.block_id === block);
    const format = mine.findIndex((c) => c.method === "block.method" && c.params.method === "format");
    const close = mine.findIndex((c) => c.method === "block.close");
    assert.ok(format >= 0 && close > format, methods(mine).join(","));
  });
});
