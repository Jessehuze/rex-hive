import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, leadRow, makeFakeClaude, McpClient, runCli, scratchDirs, seedTrustedYml } from "./helpers.mjs";
import { isolateRex, waitFor } from "./rex-helpers.mjs";

const { hasTmux, cleanup: cleanupTmux } = isolateTmux("rex processes and layout tests");
const dirs = scratchDirs();
clearHiveEnv();
const fake = isolateRex(dirs.tmp);
process.env.HIVE_DATA_DIR = dirs.dataDir;
const REX_ADDR = process.env.REX_SERVER;
const SOCKET = `rex:${REX_ADDR}`;
const rexEnv = fake.childEnv;

const { db, migrate } = await import("../dist/db.js");
migrate();
await import("../dist/rexInUse.js");
const { janitor } = await import("../dist/scheduler.js");
const { rexApi } = await import("../dist/rexCli.js");
const { REX_REAP_MAX_FAILURES, rexFloatHidden, rexLayoutPlan, rexUnfloat } = await import("../dist/terminal/rex.js");
const { configHash } = await import("../dist/projectYml.js");

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

  it("with no Rex configured, a running tmux process is started, hidden, shown, laid out and stopped with no rex call", { skip: hasTmux ? false : "tmux is not installed" }, async () => {
    const dir = freshProject("rex-none");
    const plainData = mkdtempSync(join(dirs.tmp, "plain-data-"));
    const plain = (args) => runCli(args, { cwd: dir, dataDir: plainData, tmp: dirs.tmp, env: rexEnv });
    assert.equal((await plain(["init", "--no-profile"])).code, 0);
    writeFileSync(join(dir, "hive.yml"), "processes:\n  web:\n    command: sleep 600\n");
    const { default: Database } = await import("better-sqlite3");
    const store = new Database(join(plainData, "hive.db"));
    const projectId = store.prepare("SELECT id FROM projects WHERE path = ?").get(dir).id;
    store.prepare("INSERT INTO command_trust (project_id, name, config_hash) VALUES (?, 'web', ?)").run(projectId, configHash("web", "sleep 600", null, {}));
    const before = realCalls().length;
    const started = await plain(["start", "web"]);
    assert.match(started.stdout, /web: started/, started.stdout + started.stderr);
    const row = store.prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND name = 'web' AND status = 'running'").get(projectId);
    assert.match(row.tmux_target, /^%\d+$/, "the process runs in a tmux pane");
    for (const args of [["hide", "web"], ["show", "web"], ["layout"]]) await plain(args);
    const stopped = await plain(["stop", "web"]);
    assert.match(stopped.stdout, /web: stopped/, stopped.stdout + stopped.stderr);
    store.close();
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

describe("Rex hide and show edges", () => {
  it("hive hide re-minimizes a hidden process whose float someone restored", async () => {
    const dir = freshProject("rex-rehide-cli");
    const { project } = await startLead(dir);
    await seedTrustedYml({ db, projectId: project.id, projectDir: dir, processes: { job: { command: "sleep 600", visible: false } } });
    assert.equal((await cli(["start", "job"], dir)).code, 0);
    const row = processRow(project.id, "job");
    const at = locate(row.tmux_target);
    rexApi(REX_ADDR, "session.set_layer_state", { session_id: fake.state().blocks[row.tmux_target].session_id, layer_id: at.layer.layer_id, state: "normal" });
    assert.equal(locate(row.tmux_target).layer.state, undefined);
    const hidden = await cli(["hide", "job"], dir);
    assert.match(hidden.stdout, /job: hidden/, hidden.stdout + hidden.stderr);
    assert.equal(locate(row.tmux_target).layer.state, "minimized");
  });

  it("a process shown in its own tab is hidden as a float in the lead's tab", async () => {
    const dir = freshProject("rex-tab-hide");
    const { project, lead } = await startLead(dir);
    await seedTrustedYml({ db, projectId: project.id, projectDir: dir, processes: { job: { command: "sleep 600", visible: false } } });
    writeFileSync(join(dir, "hive.yml"), `${readFileSync(join(dir, "hive.yml"), "utf8")}placement: window\n`);
    assert.equal((await cli(["start", "job"], dir)).code, 0);
    const row = processRow(project.id, "job");
    assert.match((await cli(["show", "job"], dir)).stdout, /job: shown/);
    const own = locate(row.tmux_target).window.window_id;
    assert.notEqual(own, locate(lead.tmux_target).window.window_id, "show put it in its own tab");
    const before = realCalls().length;
    assert.match((await cli(["hide", "job"], dir)).stdout, /job: hidden/);
    const where = locate(row.tmux_target);
    assert.equal(where.window.window_id, locate(lead.tmux_target).window.window_id);
    assert.equal(where.layer.kind, "floating");
    assert.equal(where.layer.state, "minimized");
    assert.equal(apiCalls(before).find((c) => c.method === "session.move_block")?.params.anchor_block_id, lead.tmux_target);
    assert.equal(fake.state().windows.some((w) => w.window_id === own), false, "its own tab closed when it left");
  });
});

describe("hive layout on Rex", () => {
  it("hive layout on Rex is the only path that resizes", async () => {
    const dir = freshProject("rex-layout");
    const before = realCalls().length;
    const { project, lead } = await startLead(dir);
    const session = fake.state().blocks[lead.tmux_target].session_id;
    const mineBlock = rexApi(REX_ADDR, "session.new_split", {
      session_id: session, anchor_id: lead.tmux_target, direction: "vertical", side: "before",
      layout: { block: { flavor: "com.superlogical.terminal.shell", label: "user-own", options: { shell: "none", login: false, command: ["sleep", "600"] } } },
    }).block_ids[0];
    const userRect = round(locate(mineBlock).rect);
    await seedTrustedYml({ db, projectId: project.id, projectDir: dir, processes: { bg: { command: "sleep 600", visible: false } } });
    assert.equal((await cli(["start", "bg"], dir)).code, 0);
    const hiddenProc = processRow(project.id, "bg").tmux_target;
    const resizing = ["session.resize_pane", "session.resize_layer"];
    assert.deepEqual(methods(apiCalls(before)).filter((m) => m === "session.resize_pane"), [], "starting the lead and a process never resizes panes");
    const spawning = realCalls().length;
    const mcp = new McpClient({ cwd: dir, dataDir: dirs.dataDir, env: withClaude({ HIVE_AGENT_ID: lead.actor_id, HIVE_SPAWN_READY_MS: "300" }) });
    clients.push(mcp);
    await mcp.start();
    const one = await mcp.call("agent_spawn", { name: "w-one", command: fakeClaude("sleep 600"), placement: "split" });
    const two = await mcp.call("agent_spawn", { name: "w-two", command: fakeClaude("sleep 600"), placement: "split" });
    assert.deepEqual(methods(apiCalls(spawning)).filter((m) => resizing.includes(m)), [], "spawning never resizes");

    const mark = realCalls().length;
    const laid = await cli(["layout"], dir);
    assert.equal(laid.code, 0, laid.stdout + laid.stderr);
    assert.ok(methods(apiCalls(mark)).filter((m) => m === "session.resize_pane").length >= 1, methods(apiCalls(mark)).join(","));
    assert.deepEqual(round(locate(lead.tmux_target).rect), [0, 0.5, 0.5, 0.25]);
    assert.deepEqual(round(locate(one.tmux_target).rect), [0.5, 0.5, 0.5, 0.25]);
    assert.deepEqual(round(locate(two.tmux_target).rect), [0, 0.75, 1, 0.25]);
    const touched = apiCalls(mark).filter((c) => ["session.move_block", "session.resize_pane"].includes(c.method)).flatMap((c) => Object.values(c.params));
    assert.equal(touched.includes(mineBlock), false, "the user's own block is never moved or resized");
    assert.equal(touched.includes(hiddenProc), false, "a hidden process stays out of the layout");
    assert.deepEqual(round(locate(mineBlock).rect), userRect);
    assert.equal(locate(hiddenProc).layer.state, "minimized");
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

let janitorProject = null;
function janitorBlock(label, script, { exitOnCompletion = false } = {}) {
  janitorProject ??= db.prepare("INSERT INTO projects (name, path) VALUES ('rex-janitor-more', ?) RETURNING id").get(freshProject("rex-janitor-more")).id;
  const made = rexApi(REX_ADDR, "session.create", {
    label: `s-${label}`,
    initial_windows: [{ window_label: label, layout: { block: { flavor: "com.superlogical.terminal.shell", label, options: { shell: "none", login: false, command: ["/bin/sh", "-c", script], exit: { on_completion: exitOnCompletion } } } } }],
  });
  const block = made.initial_windows[0].block_ids[0];
  return { session: made.session_id, block, pid: String(fake.state().blocks[block].child_pid) };
}

function janitorRow(block, pid, name) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, pane_pid, command, cwd, kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'sh', ?, 'command', 'running', datetime('now', '-10 minutes')) RETURNING id`,
    )
    .get(janitorProject, `command:${name}`, name, block, SOCKET, pid, dirs.projectDir).id;
}

const exitedNow = (b) => waitFor(() => rexApi(REX_ADDR, "block.method", { session_id: b.session, block_id: b.block, method: "process", args: {} }).last_exit != null);
const rowState = (id) => db.prepare("SELECT status, exit_tail FROM agents WHERE id = ?").get(id);

function withCaptureFailing(fn) {
  process.env.FAKE_REX_FAIL_ON = "block.method";
  try {
    return fn();
  } finally {
    delete process.env.FAKE_REX_FAIL_ON;
  }
}

describe("the janitor on Rex", () => {
  it("the janitor closes a row whose live block has another pid, and leaves that block open", () => {
    const b = janitorBlock("j-live", "sleep 600");
    const id = janitorRow(b.block, String(Number(b.pid) + 100_000), "live-other");
    const before = realCalls().length;
    janitor();
    assert.equal(rowState(id).status, "closed");
    assert.ok(fake.state().blocks[b.block], "the live block survives");
    assert.deepEqual(apiCalls(before).filter((c) => c.method === "block.close"), []);
  });

  it("a failed final-screen capture keeps the exited block open for that tick and the next tick captures it", async () => {
    const b = janitorBlock("j-retry", "sleep 0.3; echo retried words; exit 0");
    const id = janitorRow(b.block, b.pid, "retry-proc");
    await exitedNow(b);
    withCaptureFailing(() => janitor());
    assert.equal(rowState(id).status, "closed");
    assert.ok(fake.state().blocks[b.block], "a capture that threw does not close the block");
    janitor();
    assert.match(rowState(id).exit_tail, /retried words/);
    assert.equal(fake.state().blocks[b.block], undefined);
  });

  it("an exited block whose capture keeps failing is closed on the tick after the failure bound", async () => {
    const b = janitorBlock("j-bound", "sleep 0.3; echo never read; exit 0");
    const id = janitorRow(b.block, b.pid, "bound-proc");
    await exitedNow(b);
    for (let tick = 1; tick <= REX_REAP_MAX_FAILURES; tick++) {
      withCaptureFailing(() => janitor());
      assert.ok(fake.state().blocks[b.block], `still open after failed tick ${tick}`);
    }
    withCaptureFailing(() => janitor());
    assert.equal(fake.state().blocks[b.block], undefined, "closed once the bound is passed");
    assert.equal(rowState(id).exit_tail, "");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kv WHERE key LIKE 'terminal:rex:reap:%'").get().n, 0);
  });

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
