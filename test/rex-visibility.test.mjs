import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, leadRow, makeFakeClaude, McpClient, runCli, scratchDirs, seedTrustedYml } from "./helpers.mjs";
import { isolateRex, waitFor } from "./rex-helpers.mjs";

const { hasTmux, cleanup: cleanupTmux } = isolateTmux("rex visibility tests");
const dirs = scratchDirs();
const fake = isolateRex(dirs.tmp);
clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const REX_ADDR = process.env.REX_SERVER;
const rexEnv = Object.fromEntries(Object.entries(fake.env).filter(([k]) => !k.startsWith("HIVE_")));

const { db, migrate } = await import("../dist/db.js");
migrate();
await import("../dist/rexInUse.js");
const { rexApi } = await import("../dist/rexCli.js");
const { janitor, tick } = await import("../dist/scheduler.js");

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
const callName = (c) => {
  const i = c.argv.indexOf("call");
  if (i >= 0) return c.argv[i + 1];
  return c.argv.includes("do") ? "do" : c.argv.join(" ");
};
const apiCalls = (since = 0) =>
  realCalls()
    .slice(since)
    .map((c) => {
      const i = c.argv.indexOf("call");
      return i >= 0 ? { method: c.argv[i + 1], params: JSON.parse(c.argv[i + 2] ?? "{}") } : null;
    })
    .filter(Boolean);
const methods = (calls) => calls.map((c) => c.method);
const MUTATING = [
  "session.new_split", "session.new_window", "session.new_block", "session.move_block", "session.float_block",
  "session.set_layer_state", "session.resize_layer", "session.resize_pane", "session.focus_block", "block.close", "block.event",
];

function freshProject(name, yml) {
  const dir = mkdtempSync(join(dirname(dirs.projectDir), `${name}-`));
  if (yml !== undefined) writeFileSync(join(dir, "hive.yml"), yml);
  return dir;
}

const projectOf = (dir) => db.prepare("SELECT id, name, path FROM projects WHERE path = ?").get(dir);
const cli = (args, dir, env = {}) => runCli(args, { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp, env: withClaude(env) });

async function closeClients() {
  for (const client of clients.splice(0)) await client.close();
}

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

const spawn = (mcp, name, extra = {}) => mcp.call("agent_spawn", { name, command: fakeClaude("sleep 600"), ...extra });
const workerRow = (projectId, name) =>
  db.prepare("SELECT * FROM agents WHERE project_id = ? AND name = ? ORDER BY id DESC LIMIT 1").get(projectId, name);

function view(block) {
  return rexApi(REX_ADDR, "session.view", { session_id: fake.state().blocks[block].session_id });
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

function assertHiddenInLeadTab(block, lead) {
  const where = locate(block);
  const leadAt = locate(lead);
  assert.equal(where.window.window_id, leadAt.window.window_id, "the float is in the lead's tab");
  assert.equal(where.layer.kind, "floating");
  assert.equal(where.layer.state, "minimized");
  assert.deepEqual(round(where.layer.bounds), round(leadAt.rect), "the float is sized to the lead block");
}

function assertInLeadSplit(block, lead) {
  const where = locate(block);
  assert.equal(where.layer.kind, "tiled");
  assert.equal(where.window.window_id, locate(lead).window.window_id);
}

describe("worker visibility on tmux", () => {
  it("hiding a worker on tmux is refused with the Rex hint", async () => {
    const dir = freshProject("vis-tmux", "workers: hidden\n");
    const plain = (args) => runCli(args, { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp, env: rexEnv });
    assert.equal((await plain(["init", "--no-profile"])).code, 0);
    const project = projectOf(dir);
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, pane_pid, command, cwd, kind, status)
       VALUES (?, 'agent:tmux-w', 'tmux-w', '%9999', '/nonexistent/tmux-socket', '1', 'claude', ?, 'agent', 'running')`,
    ).run(project.id, dir);
    const before = realCalls().length;
    const one = await plain(["hide", "tmux-w"]);
    assert.equal(one.code, 1, one.stdout + one.stderr);
    assert.match(one.stdout, /tmux-w: hiding workers needs terminal: rex/);
    const all = await plain(["hide", "--all"]);
    assert.equal(all.code, 1, all.stdout + all.stderr);
    assert.match(all.stdout, /tmux-w: hiding workers needs terminal: rex/);
    assert.deepEqual(realCalls().slice(before), [], "a tmux worker's refusal makes no rex call");
    db.prepare("UPDATE agents SET status = 'closed' WHERE project_id = ?").run(project.id);
  });
  it("workers: hidden under tmux notes once that it needs Rex and starts workers shown", { skip: hasTmux ? false : "tmux is not installed" }, async () => {
    const dir = freshProject("vis-tmux-spawn", "workers: hidden\n");
    const plainData = mkdtempSync(join(dirs.tmp, "plain-data-"));
    assert.equal((await runCli(["init", "--no-profile"], { cwd: dir, dataDir: plainData, tmp: dirs.tmp, env: rexEnv })).code, 0);
    const before = realCalls().length;
    const mcp = new McpClient({ cwd: dir, dataDir: plainData, env: withClaude({ HIVE_SPAWN_READY_MS: "300" }) });
    await mcp.start();
    try {
      const first = await mcp.call("agent_spawn", { name: "t-one", command: fakeClaude("sleep 600"), placement: "window" });
      const second = await mcp.call("agent_spawn", { name: "t-two", command: fakeClaude("sleep 600"), placement: "window" });
      assert.match(first.tmux_target, /^%\d+$/);
      assert.match(second.tmux_target, /^%\d+$/);
      assert.match(first.note ?? "", /workers: hidden, which needs terminal: rex; under tmux it is ignored/);
      assert.doesNotMatch(second.note ?? "", /workers: hidden/, "the note is given once");
    } finally {
      await mcp.close();
      const { sessionName } = await import("../dist/tmux.js");
      process.env.HIVE_DATA_DIR = plainData;
      const session = sessionName();
      process.env.HIVE_DATA_DIR = dirs.dataDir;
      cleanupTmux(session);
    }
    assert.deepEqual(realCalls().slice(before), [], "with no Rex configured there is no rex call");
  });
});

describe("worker visibility on Rex", () => {
  it("workers: hidden spawns a minimized float in the lead's tab", async () => {
    const dir = freshProject("vis-spawn");
    const { project, lead, mcp } = await startLead(dir);
    writeFileSync(join(dir, "hive.yml"), "workers: hidden\n");
    const before = realCalls().length;
    const spawned = await spawn(mcp, "w-hid", { placement: "split" });
    assertHiddenInLeadTab(spawned.tmux_target, lead.tmux_target);
    const calls = apiCalls(before);
    const order = methods(calls).filter((m) => ["session.new_split", "session.new_window", "session.float_block", "session.set_layer_state", "session.resize_layer"].includes(m));
    assert.deepEqual(order, ["session.new_split", "session.float_block", "session.set_layer_state", "session.resize_layer"]);
    assert.equal(calls.find((c) => c.method === "session.set_layer_state").params.state, "minimized");
    assert.equal(workerRow(project.id, "w-hid").status, "running");
  });

  it("hide then show returns the worker to the lead's split", async () => {
    const dir = freshProject("vis-hide-show");
    const { lead, mcp } = await startLead(dir);
    const spawned = await spawn(mcp, "w-toggle", { placement: "split" });
    assertInLeadSplit(spawned.tmux_target, lead.tmux_target);

    const hidden = await cli(["hide", "w-toggle"], dir);
    assert.equal(hidden.code, 0, hidden.stdout + hidden.stderr);
    assert.match(hidden.stdout, /w-toggle: hidden/);
    assertHiddenInLeadTab(spawned.tmux_target, lead.tmux_target);

    const before = realCalls().length;
    const shown = await cli(["show", "w-toggle"], dir);
    assert.match(shown.stdout, /w-toggle: shown/, shown.stdout + shown.stderr);
    assert.equal(apiCalls(before).find((c) => c.method === "session.move_block")?.params.anchor_block_id, lead.tmux_target);
    assert.equal(methods(apiCalls(before)).includes("session.new_window"), false, "a split worker gets no tab");
    assertInLeadSplit(spawned.tmux_target, lead.tmux_target);
    assert.equal(locate(spawned.tmux_target).window.layers.length, 1, "the emptied float layer is gone");
    assert.match((await cli(["show", "w-toggle"], dir)).stdout, /w-toggle: already shown/);
  });

  it("hide --all and show --all cover every running worker and no process", async () => {
    const dir = freshProject("vis-all");
    const { project, lead, mcp } = await startLead(dir);
    await seedTrustedYml({ db, projectId: project.id, projectDir: dir, processes: { web: "sleep 600" } });
    assert.equal((await cli(["start", "web"], dir)).code, 0);
    const web = db.prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND name = 'web' AND status = 'running'").get(project.id).tmux_target;
    const one = await spawn(mcp, "w-a", { placement: "split" });
    const two = await spawn(mcp, "w-b", { placement: "split" });

    let before = realCalls().length;
    const hidden = await cli(["hide", "--all"], dir);
    assert.equal(hidden.code, 0, hidden.stdout + hidden.stderr);
    assert.match(hidden.stdout, /w-a: hidden/);
    assert.match(hidden.stdout, /w-b: hidden/);
    assert.doesNotMatch(hidden.stdout, /web/);
    for (const w of [one, two]) {
      const where = locate(w.tmux_target);
      assert.equal(where.window.window_id, locate(lead.tmux_target).window.window_id);
      assert.deepEqual([where.layer.kind, where.layer.state], ["floating", "minimized"]);
    }
    assert.equal(locate(web).layer.kind, "tiled", "the process stays shown");
    const touchedOnHide = apiCalls(before).filter((c) => MUTATING.includes(c.method)).flatMap((c) => Object.values(c.params));
    assert.equal(touchedOnHide.includes(web), false, "hide --all makes no mutating call naming the process");

    before = realCalls().length;
    const shown = await cli(["show", "--all"], dir);
    assert.match(shown.stdout, /w-a: shown/, shown.stdout + shown.stderr);
    assert.match(shown.stdout, /w-b: shown/);
    for (const w of [one, two]) assertInLeadSplit(w.tmux_target, lead.tmux_target);
    const touchedOnShow = apiCalls(before).filter((c) => MUTATING.includes(c.method)).flatMap((c) => Object.values(c.params));
    assert.equal(touchedOnShow.includes(web), false, "show --all makes no mutating call naming the process");

    assert.match((await cli(["hide", "web"], dir)).stdout, /web: hidden/);
    const again = await cli(["show", "--all"], dir);
    assert.match(again.stdout, /w-a: already shown/);
    assert.equal(locate(web).layer.state, "minimized", "show --all leaves a hidden process hidden");
  });

  it("peek restores and focuses without moving the worker into the split", async () => {
    const dir = freshProject("vis-peek");
    const { lead, mcp } = await startLead(dir);
    writeFileSync(join(dir, "hive.yml"), "workers: hidden\n");
    const spawned = await spawn(mcp, "w-peek", { placement: "split" });
    const layer = locate(spawned.tmux_target).layer.layer_id;

    const before = realCalls().length;
    const peeked = await cli(["peek", "w-peek"], dir);
    assert.equal(peeked.code, 0, peeked.stdout + peeked.stderr);
    assert.match(peeked.stdout, /w-peek: peeking/);
    const mutating = apiCalls(before).filter((c) => MUTATING.includes(c.method));
    assert.deepEqual(methods(mutating), ["session.set_layer_state"]);
    assert.deepEqual([mutating[0].params.layer_id, mutating[0].params.state, mutating[0].params.focus], [layer, "normal", true]);
    const where = locate(spawned.tmux_target);
    assert.equal(where.layer.kind, "floating", "the worker is still a float, not in the split");
    assert.notEqual(where.layer.state, "minimized");
    assert.equal(where.window.window_id, locate(lead.tmux_target).window.window_id);
    assert.equal(where.window.focused_block_id, spawned.tmux_target);

    const mark = realCalls().length;
    assert.match((await cli(["hide", "w-peek"], dir)).stdout, /w-peek: hidden/);
    assert.equal(locate(spawned.tmux_target).layer.state, "minimized");
    assert.equal(methods(apiCalls(mark)).includes("session.float_block"), false, "re-hiding a peeked float never floats it twice");
  });

  it("peek raises the worker above another float in the lead's tab", async () => {
    const dir = freshProject("vis-peek-raise");
    const { mcp } = await startLead(dir);
    writeFileSync(join(dir, "hive.yml"), "workers: hidden\n");
    const low = await spawn(mcp, "w-low", { placement: "split" });
    const high = await spawn(mcp, "w-high", { placement: "split" });
    const stack = () => locate(low.tmux_target).window.layers.map((l) => l.blocks.map((b) => b.block_id)[0]);
    assert.ok(stack().indexOf(low.tmux_target) < stack().indexOf(high.tmux_target), "the fixture floats w-low below w-high");
    assert.match((await cli(["peek", "w-high"], dir)).stdout, /w-high: peeking/);
    assert.match((await cli(["peek", "w-low"], dir)).stdout, /w-low: peeking/);
    const order = stack();
    assert.equal(order.at(-1), low.tmux_target, `the peeked worker is the top layer: ${order.join(", ")}`);
    assert.notEqual(locate(high.tmux_target).layer.state, "minimized", "the other float stays restored, now beneath it");
  });

  it("the janitor closing a worker's row forgets its remembered show placement", async () => {
    const dir = freshProject("vis-forget");
    const { project, mcp } = await startLead(dir);
    writeFileSync(join(dir, "hive.yml"), "workers: hidden\nplacement: window\n");
    const gone = await spawn(mcp, "w-gone", { placement: "split" });
    const kept = await spawn(mcp, "w-kept", { placement: "split" });
    const shownAs = (block) => db.prepare("SELECT value FROM kv WHERE project_id = ? AND key = ?").get(project.id, `terminal:rex:shown-as:${block}`)?.value;
    assert.equal(shownAs(gone.tmux_target), "split", "the fixture remembers where the hidden worker shows");
    assert.equal(shownAs(kept.tmux_target), "split");
    await closeClients();
    db.prepare("UPDATE agents SET created_at = datetime('now', '-10 minutes') WHERE project_id = ? AND name IN ('w-gone', 'w-kept')").run(project.id);
    rexApi(REX_ADDR, "block.close", { session_id: fake.state().blocks[gone.tmux_target].session_id, block_id: gone.tmux_target });
    janitor();
    assert.equal(workerRow(project.id, "w-gone").status, "closed");
    assert.equal(shownAs(gone.tmux_target), undefined, "the closed row's kv row is deleted");
    assert.equal(workerRow(project.id, "w-kept").status, "running");
    assert.equal(shownAs(kept.tmux_target), "split", "a live worker keeps its kv row");
  });

  it("hidden placement:window worker floats in the lead's tab and show gives it a new tab", async () => {
    const dir = freshProject("vis-window");
    const { project, lead, mcp } = await startLead(dir);
    writeFileSync(join(dir, "hive.yml"), "workers: hidden\nplacement: window\n");
    const before = realCalls().length;
    const spawned = await spawn(mcp, "w-tab");
    assert.equal(methods(apiCalls(before)).includes("session.new_window"), false, "a hidden window worker opens no tab");
    assertHiddenInLeadTab(spawned.tmux_target, lead.tmux_target);

    const mark = realCalls().length;
    const blocksBefore = new Set(Object.keys(fake.state().blocks));
    const shown = await cli(["show", "w-tab"], dir);
    assert.match(shown.stdout, /w-tab: shown/, shown.stdout + shown.stderr);
    const seq = methods(apiCalls(mark)).filter((m) => ["session.new_window", "session.move_block", "block.close"].includes(m));
    assert.deepEqual(seq, ["session.new_window", "session.move_block", "block.close"]);
    const where = locate(spawned.tmux_target);
    assert.notEqual(where.window.window_id, locate(lead.tmux_target).window.window_id);
    assert.equal(where.window.label, `${project.name}/w-tab`);
    assert.equal(where.layer.kind, "tiled");
    assert.deepEqual(Object.keys(fake.state().blocks).filter((id) => !blocksBefore.has(id)), [], "the placeholder block is closed");
  });

  it("a worker hidden from its own tab returns to a new tab on show, whatever hive.yml placement says", async () => {
    const dir = freshProject("vis-own-tab");
    const { lead, mcp } = await startLead(dir);
    const spawned = await spawn(mcp, "w-own", { placement: "window" });
    const own = locate(spawned.tmux_target).window.window_id;
    assert.notEqual(own, locate(lead.tmux_target).window.window_id);
    assert.match((await cli(["hide", "w-own"], dir)).stdout, /w-own: hidden/);
    assertHiddenInLeadTab(spawned.tmux_target, lead.tmux_target);
    assert.match((await cli(["show", "w-own"], dir)).stdout, /w-own: shown/);
    assert.notEqual(locate(spawned.tmux_target).window.window_id, locate(lead.tmux_target).window.window_id);
  });

  it("hide on a hidden worker says already hidden and makes no rex call", async () => {
    const dir = freshProject("vis-already");
    const { mcp } = await startLead(dir);
    writeFileSync(join(dir, "hive.yml"), "workers: hidden\n");
    await spawn(mcp, "w-quiet", { placement: "split" });
    await closeClients();
    const before = realCalls().length;
    const again = await cli(["hide", "w-quiet"], dir);
    assert.equal(again.code, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /w-quiet: already hidden/);
    const made = realCalls().slice(before).map(callName);
    const READS = new Set(["do", "target.resolve", "session.view"]);
    assert.deepEqual(made.filter((m) => !READS.has(m)), [], `only the ownership snapshot and one placement read are allowed: ${made.join(", ")}`);
    assert.deepEqual(made, ["do", "target.resolve", "session.view"], "one ownership snapshot, then one session lookup and one view");
    assert.deepEqual(made.filter((m) => MUTATING.includes(m)), []);
  });

  it("a name that is both a hive.yml process and a running worker is refused", async () => {
    const dir = freshProject("vis-ambiguous");
    const { project, mcp } = await startLead(dir);
    await spawn(mcp, "both", { placement: "split" });
    await seedTrustedYml({ db, projectId: project.id, projectDir: dir, processes: { both: "sleep 600" } });
    const before = realCalls().length;
    const refused = await cli(["hide", "both"], dir);
    assert.equal(refused.code, 1, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /ambiguous: both is both a process and a worker/);
    assert.deepEqual(apiCalls(before).filter((c) => MUTATING.includes(c.method)), []);
  });

  it("a hidden worker's block is owned, never an unowned leftover of the lead's handoff", async () => {
    const dir = freshProject("vis-unowned");
    const { project, mcp } = await startLead(dir);
    writeFileSync(join(dir, "hive.yml"), "workers: hidden\n");
    const spawned = await spawn(mcp, "w-owned", { placement: "split" });
    await closeClients();
    assert.equal(locate(spawned.tmux_target).layer.state, "minimized");
    const { rexUnownedBlocks } = await import("../dist/terminal/rex.js");
    const unowned = () => (rexUnownedBlocks(REX_ADDR) ?? []).map((b) => b.block);
    assert.equal(unowned().includes(spawned.tmux_target), false, "a running hidden worker's float is owned");
    const row = workerRow(project.id, "w-owned");
    db.prepare("UPDATE agents SET status = 'closed' WHERE id = ?").run(row.id);
    assert.equal(unowned().includes(spawned.tmux_target), true, "the same float with its row closed does read unowned, so the check can fail");
  });

  it("wakes deliver to a hidden worker", async () => {
    const dir = freshProject("vis-wake");
    const { mcp } = await startLead(dir);
    writeFileSync(join(dir, "hive.yml"), "workers: hidden\n");
    const spawned = await spawn(mcp, "w-wake", { placement: "split" });
    assert.equal(locate(spawned.tmux_target).layer.state, "minimized");
    await mcp.call("wake_set", { delay_seconds: 1, body: "HIDDENWAKEMARK", deliver_to: "w-wake" });
    await new Promise((r) => setTimeout(r, 1200));
    await tick();
    await waitFor(() => fake.state().blocks[spawned.tmux_target].events.some((e) => e.type === "paste"), { timeoutMs: 8000 });
    const paste = fake.state().blocks[spawned.tmux_target].events.find((e) => e.type === "paste");
    assert.match(paste.payload.text, /HIDDENWAKEMARK/);
    assert.equal(locate(spawned.tmux_target).layer.state, "minimized", "delivery leaves the worker hidden");
  });
});

