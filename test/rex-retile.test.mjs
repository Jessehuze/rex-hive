import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, leadRow, makeFakeClaude, McpClient, runCli, scratchDirs, seedTrustedYml } from "./helpers.mjs";
import { isolateRex } from "./rex-helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("rex retile tests");
const dirs = scratchDirs();
clearHiveEnv();
const fake = isolateRex(dirs.tmp);
process.env.HIVE_DATA_DIR = dirs.dataDir;
const REX_ADDR = process.env.REX_SERVER;
const rexEnv = fake.childEnv;

const { db, migrate } = await import("../dist/db.js");
migrate();
await import("../dist/rexInUse.js");
const { rexApi } = await import("../dist/rexCli.js");
const { rexLayoutPlan } = await import("../dist/terminal/rex.js");
const { loadProjectYml } = await import("../dist/projectYml.js");

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
      return i >= 0 ? { method: c.argv[i + 1], params: JSON.parse(c.argv[i + 2] ?? "{}") } : null;
    })
    .filter(Boolean);
const LAYOUT_METHODS = ["session.move_block", "session.resize_pane"];
const layoutCalls = (since) => apiCalls(since).filter((c) => LAYOUT_METHODS.includes(c.method));
const touchedBlocks = (since) =>
  layoutCalls(since).flatMap((c) => [c.params.block_id, c.params.anchor_block_id, c.params.before_block_id, c.params.after_block_id]).filter(Boolean);

function planCalls(lead, blocks, layout) {
  const plan = rexLayoutPlan(lead, blocks, layout);
  return [
    ...plan.moves.map((m) => ({ method: "session.move_block", block: m.block, anchor: m.anchor, direction: m.direction })),
    ...plan.resizes.map((r) => ({ method: "session.resize_pane", before: r.before, after: r.after, direction: r.direction, ratio: r.ratio })),
  ];
}

const asPlan = (calls) =>
  calls.map((c) =>
    c.method === "session.move_block"
      ? { method: c.method, block: c.params.block_id, anchor: c.params.anchor_block_id, direction: c.params.direction }
      : { method: c.method, before: c.params.before_block_id, after: c.params.after_block_id, direction: c.params.direction, ratio: c.params.ratio },
  );

function freshProject(name, yml) {
  const dir = mkdtempSync(join(dirname(dirs.projectDir), `${name}-`));
  if (yml !== undefined) writeFileSync(join(dir, "hive.yml"), yml);
  return dir;
}

const projectOf = (dir) => db.prepare("SELECT id, name, path FROM projects WHERE path = ?").get(dir);
const cli = (args, dir, env = {}) => runCli(args, { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp, env: withClaude(env) });

async function startLead(dir) {
  const result = await cli(["lead", dir, "--detach"], dir, { HIVE_TERMINAL: "rex" });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const project = projectOf(dir);
  const lead = leadRow(db, project.id);
  const mcp = new McpClient({ cwd: dir, dataDir: dirs.dataDir, env: withClaude({ HIVE_AGENT_ID: lead.actor_id, HIVE_SPAWN_READY_MS: "300" }) });
  clients.push(mcp);
  await mcp.start();
  return { project, lead, mcp };
}

async function mcpAs(dir, actor, env = {}) {
  const mcp = new McpClient({ cwd: dir, dataDir: dirs.dataDir, env: withClaude({ HIVE_AGENT_ID: actor, HIVE_SPAWN_READY_MS: "300", ...env }) });
  clients.push(mcp);
  await mcp.start();
  return mcp;
}

async function waitForCall(since, method) {
  const deadline = Date.now() + 30_000;
  while (!apiCalls(since).some((c) => c.method === method)) {
    if (Date.now() > deadline) throw new Error(`${method} never started`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const spawn = (mcp, name, extra = {}) => mcp.call("agent_spawn", { name, command: fakeClaude("sleep 600"), placement: "split", ...extra });
const processRow = (projectId, name) =>
  db.prepare("SELECT * FROM agents WHERE project_id = ? AND name = ? AND kind = 'command' ORDER BY id DESC LIMIT 1").get(projectId, name);

function windowOf(block) {
  const state = fake.state();
  return state.blocks[block]?.window_id ?? null;
}

describe("retile on Rex (on by default)", () => {
  it("with retile absent and layout tiled, each of four split spawns issues exactly rexLayoutPlan's moves and resizes for the tab so far", async () => {
    const dir = freshProject("retile-grid", "layout: tiled\n");
    const { lead, mcp } = await startLead(dir);
    const workers = [];
    for (const name of ["g1", "g2", "g3", "g4"]) {
      const mark = realCalls().length;
      const spawned = await spawn(mcp, name);
      workers.push(spawned.tmux_target);
      assert.deepEqual(asPlan(layoutCalls(mark)), planCalls(lead.tmux_target, workers, "tiled"), `after spawning ${name}`);
    }
    assert.ok(layoutCalls(0).some((c) => c.method === "session.resize_pane"), "the four-worker grid resizes, so the plan comparison covers resizes");
  });

  it("with retile: false, spawning three split workers issues zero move_block and resize_pane calls", async () => {
    const dir = freshProject("retile-off", "retile: false\n");
    const { mcp } = await startLead(dir);
    const mark = realCalls().length;
    for (const name of ["o1", "o2", "o3"]) await spawn(mcp, name);
    assert.deepEqual(layoutCalls(mark), []);
  });

  it("with retile: false in the global hive.yml and absent in the project, spawning issues zero layout calls", async () => {
    const own = scratchDirs();
    mkdirSync(own.dataDir, { recursive: true });
    writeFileSync(join(own.dataDir, "hive.yml"), "retile: false\n");
    const dir = freshProject("retile-global-off");
    const run = (args, env = {}) => runCli(args, { cwd: dir, dataDir: own.dataDir, tmp: own.tmp, env: withClaude(env) });
    assert.equal((await run(["lead", dir, "--detach"], { HIVE_TERMINAL: "rex" })).code, 0);
    const { default: Database } = await import("better-sqlite3");
    const store = new Database(join(own.dataDir, "hive.db"), { readonly: true });
    const lead = store.prepare("SELECT actor_id FROM agents WHERE kind = 'lead' AND status = 'running'").get();
    store.close();
    const mcp = new McpClient({ cwd: dir, dataDir: own.dataDir, env: withClaude({ HIVE_AGENT_ID: lead.actor_id, HIVE_SPAWN_READY_MS: "300" }) });
    clients.push(mcp);
    await mcp.start();
    const mark = realCalls().length;
    await spawn(mcp, "go1");
    await spawn(mcp, "go2");
    assert.deepEqual(layoutCalls(mark), []);
  });

  it("a window worker, a hidden worker and a block hive does not own in the lead's tab are left out of every re-tile", async () => {
    const dir = freshProject("retile-exclude");
    const { lead, mcp } = await startLead(dir);
    const session = fake.state().blocks[lead.tmux_target].session_id;
    const mine = rexApi(REX_ADDR, "session.new_split", {
      session_id: session, anchor_id: lead.tmux_target, direction: "vertical", side: "before",
      layout: { block: { flavor: "com.superlogical.terminal.shell", label: "user-own", options: { shell: "none", login: false, command: ["sleep", "600"] } } },
    }).block_ids[0];
    const tab = await spawn(mcp, "x-tab", { placement: "window" });
    const tabWindow = windowOf(tab.tmux_target);
    writeFileSync(join(dir, "hive.yml"), "workers: hidden\n");
    const hidden = await spawn(mcp, "x-hidden");
    writeFileSync(join(dir, "hive.yml"), "workers: shown\n");
    const mark = realCalls().length;
    const one = await spawn(mcp, "x-one");
    const two = await spawn(mcp, "x-two");
    assert.ok(layoutCalls(mark).length > 0, "the split spawns re-tiled, so the exclusions are checked against real calls");
    const touched = touchedBlocks(0);
    assert.deepEqual(asPlan(layoutCalls(mark)).slice(-planCalls(lead.tmux_target, [one.tmux_target, two.tmux_target], "tiled").length),
      planCalls(lead.tmux_target, [one.tmux_target, two.tmux_target], "tiled"));
    for (const [what, block] of [["the window worker", tab.tmux_target], ["the hidden worker", hidden.tmux_target], ["the user's own block", mine]]) {
      assert.equal(touched.includes(block), false, `${what} is never moved or resized`);
    }
    assert.equal(windowOf(tab.tmux_target), tabWindow, "the window worker stays in its own tab");
    assert.notEqual(windowOf(tab.tmux_target), windowOf(lead.tmux_target));
  });

  it("agent_close of a split worker re-tiles the workers left; closing one with retile: false issues no layout calls", async () => {
    const dir = freshProject("retile-close");
    const { lead, mcp } = await startLead(dir);
    const a = await spawn(mcp, "c-a");
    const b = await spawn(mcp, "c-b");
    const c = await spawn(mcp, "c-c");
    let mark = realCalls().length;
    await mcp.call("agent_close", { name: "c-b" });
    assert.deepEqual(asPlan(layoutCalls(mark)), planCalls(lead.tmux_target, [a.tmux_target, c.tmux_target], "tiled"));
    writeFileSync(join(dir, "hive.yml"), "retile: false\n");
    mark = realCalls().length;
    await mcp.call("agent_close", { name: "c-c" });
    assert.equal(fake.state().blocks[c.tmux_target], undefined, "the control: the close still happened");
    assert.deepEqual(layoutCalls(mark), []);
  });

  it("hive hide re-tiles without the hidden worker and hive show re-tiles with it back", async () => {
    const dir = freshProject("retile-hide-show");
    const { lead, mcp } = await startLead(dir);
    const a = await spawn(mcp, "h-a");
    const b = await spawn(mcp, "h-b");
    const c = await spawn(mcp, "h-c");
    let mark = realCalls().length;
    const hidden = await cli(["hide", "h-b"], dir);
    assert.match(hidden.stdout, /h-b: hidden/, hidden.stdout + hidden.stderr);
    assert.deepEqual(asPlan(layoutCalls(mark)), planCalls(lead.tmux_target, [a.tmux_target, c.tmux_target], "tiled"));
    mark = realCalls().length;
    const shown = await cli(["show", "h-b"], dir);
    assert.match(shown.stdout, /h-b: shown/, shown.stdout + shown.stderr);
    const calls = asPlan(layoutCalls(mark));
    assert.deepEqual(calls[0], { method: "session.move_block", block: b.tmux_target, anchor: lead.tmux_target, direction: "horizontal" }, "the unfloat comes first");
    assert.deepEqual(calls.slice(1), planCalls(lead.tmux_target, [a.tmux_target, b.tmux_target, c.tmux_target], "tiled"));
  });

  it("hive start of a visible process re-tiles with it, and hive stop re-tiles without it", async () => {
    const dir = freshProject("retile-process");
    const { project, lead, mcp } = await startLead(dir);
    const a = await spawn(mcp, "p-a");
    await seedTrustedYml({ db, projectId: project.id, projectDir: dir, processes: { web: "sleep 600" } });
    let mark = realCalls().length;
    assert.equal((await cli(["start", "web"], dir)).code, 0);
    const web = processRow(project.id, "web");
    assert.deepEqual(asPlan(layoutCalls(mark)), planCalls(lead.tmux_target, [a.tmux_target, web.tmux_target], "tiled"));
    mark = realCalls().length;
    const stopped = await cli(["stop", "web"], dir);
    assert.match(stopped.stdout, /web: stopped/, stopped.stdout + stopped.stderr);
    assert.deepEqual(asPlan(layoutCalls(mark)), planCalls(lead.tmux_target, [a.tmux_target], "tiled"));
  });

  it("agent_fork and agent_resume of split workers re-tile with the new block", async () => {
    const dir = freshProject("retile-fork-resume");
    const { lead, mcp } = await startLead(dir);
    const source = await spawn(mcp, "f-src");
    const transcript = join(dir, "source-transcript.jsonl");
    writeFileSync(transcript, "{}\n");
    db.prepare("UPDATE agents SET transcript_path = ? WHERE id = ?").run(transcript, source.agent_id);
    let mark = realCalls().length;
    const forked = await mcp.call("agent_fork", { agent_id: source.agent_id, name: "f-fork" });
    assert.deepEqual(asPlan(layoutCalls(mark)), planCalls(lead.tmux_target, [source.tmux_target, forked.tmux_target], "tiled"));
    await mcp.call("agent_close", { name: "f-src" });
    mark = realCalls().length;
    const resumed = await mcp.call("agent_resume", { name: "f-src" });
    assert.deepEqual(asPlan(layoutCalls(mark)), planCalls(lead.tmux_target, [forked.tmux_target, resumed.tmux_target], "tiled"));
  });

  it("a re-tile whose first move_block fails stops there, with no further move or resize, and leaves the spawn succeeded and its row running", async () => {
    const dir = freshProject("retile-fail");
    const { project, lead } = await startLead(dir);
    await spawnFirst(dir, lead);
    const mcp = new McpClient({
      cwd: dir, dataDir: dirs.dataDir,
      env: withClaude({ HIVE_AGENT_ID: lead.actor_id, HIVE_SPAWN_READY_MS: "300", FAKE_REX_FAIL_ON: "session.move_block" }),
    });
    clients.push(mcp);
    await mcp.start();
    const mark = realCalls().length;
    const spawned = await spawn(mcp, "fail-2");
    assert.deepEqual(layoutCalls(mark).map((c) => c.method), ["session.move_block"], "one failed move and nothing after it");
    const row = db.prepare("SELECT status, tmux_target FROM agents WHERE project_id = ? AND name = 'fail-2'").get(project.id);
    assert.equal(row.status, "running");
    assert.equal(row.tmux_target, spawned.tmux_target);
  });

  it("a split worker spawning a sub-worker re-tiles around the project lead, never around the worker", async () => {
    const dir = freshProject("retile-sub-split");
    const { lead, mcp } = await startLead(dir);
    const w1 = await spawn(mcp, "sw1");
    const w2 = await spawn(mcp, "sw2");
    const sub = await mcpAs(dir, db.prepare("SELECT actor_id FROM agents WHERE id = ?").get(w1.agent_id).actor_id);
    const mark = realCalls().length;
    const s1 = await spawn(sub, "ss1");
    assert.deepEqual(asPlan(layoutCalls(mark)), planCalls(lead.tmux_target, [w1.tmux_target, w2.tmux_target, s1.tmux_target], "tiled"));
  });

  it("a placement: window worker spawning and closing a sub-worker issues zero move_block and resize_pane calls", async () => {
    const dir = freshProject("retile-sub-window");
    const { mcp } = await startLead(dir);
    await spawn(mcp, "tw-a");
    const tab = await spawn(mcp, "tw-tab", { placement: "window" });
    const sub = await mcpAs(dir, db.prepare("SELECT actor_id FROM agents WHERE id = ?").get(tab.agent_id).actor_id);
    const mark = realCalls().length;
    const s1 = await spawn(sub, "tw-s1");
    assert.notEqual(windowOf(s1.tmux_target), null, "the sub-worker was placed");
    await mcp.call("agent_close", { name: "tw-s1" });
    assert.equal(fake.state().blocks[s1.tmux_target], undefined, "the control: the close happened");
    assert.deepEqual(layoutCalls(mark), []);
  });

  it("a re-tile holds no store write lock and abandons a slow call: with move_block delayed 7s, another server's kv_set succeeds within 3s and the spawn returns before the 7s are up", async () => {
    const dir = freshProject("retile-lock");
    const { lead, mcp } = await startLead(dir);
    await spawn(mcp, "lk-a");
    const slow = await mcpAs(dir, lead.actor_id, { FAKE_REX_SLEEP_ON: "session.move_block:7000" });
    const mark = realCalls().length;
    const spawning = spawn(slow, "lk-b").then((r) => ({ ok: r }), (e) => ({ err: String(e) }));
    await waitForCall(mark, "session.move_block");
    const started = Date.now();
    const write = await mcp.call("kv_set", { key: "retile-probe", value: "1" }).then(() => "ok", (e) => String(e));
    assert.equal(write, "ok");
    assert.ok(Date.now() - started < 3000, `kv_set took ${Date.now() - started}ms`);
    const outcome = await spawning;
    assert.ok(outcome.ok, `the spawn itself still succeeds: ${outcome.err ?? ""}`);
    assert.ok(Date.now() - started < 7000, `the spawn waited ${Date.now() - started}ms after the move began, so the delayed call was not abandoned`);
  });

  it("a healthy but slow Rex finishes the whole plan: with every move_block taking 800ms, a five-worker grid makes every planned move and resize", async () => {
    const dir = freshProject("retile-slow-healthy");
    const { lead, mcp } = await startLead(dir);
    const workers = [];
    for (const name of ["sh1", "sh2", "sh3", "sh4"]) workers.push((await spawn(mcp, name)).tmux_target);
    const slow = await mcpAs(dir, lead.actor_id, { FAKE_REX_SLEEP_ON: "session.move_block:800" });
    const mark = realCalls().length;
    const fifth = await spawn(slow, "sh5");
    assert.deepEqual(asPlan(layoutCalls(mark)), planCalls(lead.tmux_target, [...workers, fifth.tmux_target], "tiled"));
  });

  it("a re-tile stops at its first timed-out call: with move_block hanging 5s, the spawn attempts one move, no resize, and still succeeds", async () => {
    const dir = freshProject("retile-hung");
    const { project, lead, mcp } = await startLead(dir);
    for (const name of ["hg1", "hg2", "hg3"]) await spawn(mcp, name);
    const slow = await mcpAs(dir, lead.actor_id, { FAKE_REX_SLEEP_ON: "session.move_block:5000" });
    const mark = realCalls().length;
    const spawned = await spawn(slow, "hg4");
    assert.deepEqual(layoutCalls(mark).map((c) => c.method), ["session.move_block"], "one timed-out move and nothing after it");
    const row = db.prepare("SELECT status, tmux_target FROM agents WHERE project_id = ? AND name = 'hg4'").get(project.id);
    assert.equal(row.status, "running");
    assert.equal(row.tmux_target, spawned.tmux_target);
  });

  it("the lead's own end stops its processes without re-tiling", async () => {
    const dir = freshProject("retile-lead-end");
    const { project, lead, mcp } = await startLead(dir);
    await spawn(mcp, "le-a");
    await seedTrustedYml({ db, projectId: project.id, projectDir: dir, processes: { web: "sleep 600" } });
    assert.equal((await cli(["start", "web"], dir)).code, 0);
    const web = processRow(project.id, "web");
    const mark = realCalls().length;
    assert.equal((await cli(["lead-pane-exited", lead.tmux_target], dir)).code, 0);
    assert.equal(processRow(project.id, "web").status, "closed", "the control: the lead's end stopped the process");
    assert.equal(fake.state().blocks[web.tmux_target], undefined);
    assert.deepEqual(layoutCalls(mark), []);
  });

  it("agent_park of a split worker re-tiles the workers left", async () => {
    const dir = freshProject("retile-park");
    const { lead, mcp } = await startLead(dir);
    const a = await spawn(mcp, "pk-a");
    await spawn(mcp, "pk-b");
    const c = await spawn(mcp, "pk-c");
    const mark = realCalls().length;
    await mcp.call("agent_park", { name: "pk-b" });
    assert.deepEqual(asPlan(layoutCalls(mark)), planCalls(lead.tmux_target, [a.tmux_target, c.tmux_target], "tiled"));
  });

  it("show --all unfloats every worker first and re-tiles once at the end", async () => {
    const dir = freshProject("retile-all");
    const { lead, mcp } = await startLead(dir);
    const ws = [];
    for (const name of ["al-a", "al-b", "al-c"]) ws.push((await spawn(mcp, name)).tmux_target);
    assert.equal((await cli(["hide", "--all"], dir)).code, 0);
    const mark = realCalls().length;
    const shown = await cli(["show", "--all"], dir);
    assert.equal(shown.code, 0, shown.stdout + shown.stderr);
    const unfloats = ws.map((b) => ({ method: "session.move_block", block: b, anchor: lead.tmux_target, direction: "horizontal" }));
    assert.deepEqual(asPlan(layoutCalls(mark)), [...unfloats, ...planCalls(lead.tmux_target, ws, "tiled")]);
  });

  it("closing a window worker or a hidden worker issues zero layout calls while a split worker shares the lead's tab", async () => {
    const dir = freshProject("retile-close-excluded");
    const { mcp } = await startLead(dir);
    await spawn(mcp, "ce-split");
    const tab = await spawn(mcp, "ce-tab", { placement: "window" });
    writeFileSync(join(dir, "hive.yml"), "workers: hidden\n");
    const hidden = await spawn(mcp, "ce-hidden");
    const mark = realCalls().length;
    await mcp.call("agent_close", { name: "ce-tab" });
    await mcp.call("agent_close", { name: "ce-hidden" });
    assert.equal(fake.state().blocks[tab.tmux_target], undefined, "the control: the window worker closed");
    assert.equal(fake.state().blocks[hidden.tmux_target], undefined, "the control: the hidden worker closed");
    assert.deepEqual(layoutCalls(mark), []);
  });

  it("with retile: false, hive hide and hive stop make no layout calls and hive show makes only its unfloat move", async () => {
    const dir = freshProject("retile-off-visibility");
    const { project, lead, mcp } = await startLead(dir);
    const a = await spawn(mcp, "of-a");
    await spawn(mcp, "of-b");
    await seedTrustedYml({ db, projectId: project.id, projectDir: dir, processes: { web: "sleep 600" } });
    appendFileSync(join(dir, "hive.yml"), "retile: false\n");
    assert.equal((await cli(["start", "web"], dir)).code, 0);
    let mark = realCalls().length;
    assert.match((await cli(["hide", "of-a"], dir)).stdout, /of-a: hidden/);
    assert.deepEqual(layoutCalls(mark), [], "hide");
    mark = realCalls().length;
    assert.match((await cli(["show", "of-a"], dir)).stdout, /of-a: shown/);
    assert.deepEqual(asPlan(layoutCalls(mark)), [{ method: "session.move_block", block: a.tmux_target, anchor: lead.tmux_target, direction: "horizontal" }], "show");
    mark = realCalls().length;
    assert.match((await cli(["stop", "web"], dir)).stdout, /web: stopped/);
    assert.deepEqual(layoutCalls(mark), [], "stop");
  });

  it("hive doctor shows retile on (built-in) by default and off (project) when hive.yml sets it false", async () => {
    const dir = freshProject("retile-doctor");
    await startLead(dir);
    const on = await cli(["doctor"], dir);
    assert.match(on.stdout, /retile: on \(built-in\)/, on.stdout);
    writeFileSync(join(dir, "hive.yml"), "retile: false\n");
    const off = await cli(["doctor"], dir);
    assert.match(off.stdout, /retile: off \(project\)/, off.stdout);
  });

  it("retile parses as a boolean, null resets it, and a non-boolean warns and is ignored", () => {
    const dir = freshProject("retile-parse", "retile: true\n");
    assert.equal(loadProjectYml(dir).config.retile, true);
    assert.deepEqual(loadProjectYml(dir).warnings, [], "a valid retile warns about nothing, whatever the terminal");
    writeFileSync(join(dir, "hive.yml"), "retile: false\n");
    assert.equal(loadProjectYml(dir).config.retile, false);
    writeFileSync(join(dir, "hive.yml"), "retile: null\n");
    assert.equal(loadProjectYml(dir).config.retile, null);
    writeFileSync(join(dir, "hive.yml"), "retile: sometimes\n");
    const loaded = loadProjectYml(dir);
    assert.equal(loaded.config.retile, null);
    assert.ok(loaded.warnings.some((w) => /retile must be true or false; ignoring "sometimes"/.test(w)), loaded.warnings.join("\n"));
  });
});

async function spawnFirst(dir, lead) {
  const mcp = new McpClient({ cwd: dir, dataDir: dirs.dataDir, env: withClaude({ HIVE_AGENT_ID: lead.actor_id, HIVE_SPAWN_READY_MS: "300" }) });
  clients.push(mcp);
  await mcp.start();
  await spawn(mcp, "fail-1");
}
