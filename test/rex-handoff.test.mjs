import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { DIST, REPO, clearHiveEnv, isolateTmux, leadRow, runCli, runNode, scratchDirs, until } from "./helpers.mjs";
import { fakeRexDo, isolateRex } from "./rex-helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("rex handoff tests");
const dirs = scratchDirs();
const fake = isolateRex(dirs.tmp);
clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const rexEnv = Object.fromEntries(Object.entries(fake.env).filter(([k]) => !k.startsWith("HIVE_")));

const { db, migrate } = await import("../dist/db.js");
if (!db.name.startsWith(dirs.dataDir)) throw new Error(`refusing: opened ${db.name}`);
migrate();
await import("../dist/rexInUse.js");
const handoff = await import("../dist/leadHandoff.js");
const { tick } = await import("../dist/scheduler.js");
const { rexUnownedBlocks } = await import("../dist/terminal/rex.js");
const { rexApi } = await import("../dist/rexCli.js");
const { sendQuietLeadMessage, retryQuietLeadMessages } = await import("../dist/leadMessageDelivery.js");

after(() => {
  fake.cleanup();
  cleanupTmux();
});

const HOOK = join(DIST, "hook.js");
const READY = join(REPO, "test", "fixtures", "panes", "ready-idle.txt");
const fixture = (name) => JSON.parse(readFileSync(join(REPO, "test", "fixtures", "hook-payloads", name), "utf8"));
const SESSION = fixture("lead-claude-prompt.json").session_id;
const SUCCESSOR = "rex-successor-session";
const PAD = handoff.HANDOFF_HEADINGS.map((h) => `${h}\nnone`).join("\n\n");

const bin = join(dirs.tmp, "claude-bin");
mkdirSync(bin, { recursive: true });
const hookCall = (event) => `'${process.execPath}' '${HOOK}' ${event} < "$PWD/successor-${event}.json" > /dev/null 2>&1`;
writeFileSync(
  join(bin, "claude"),
  [
    "#!/bin/sh",
    `cat '${READY}'`,
    'if [ -f "$PWD/successor.flag" ]; then',
    "  sleep 1.5",
    `  ${hookCall("prompt")}`,
    `  ${hookCall("stop")}`,
    '  exec cat >> "$PWD/received.txt"',
    "fi",
    "exec cat",
    "",
  ].join("\n"),
);
chmodSync(join(bin, "claude"), 0o755);
const withClaude = (env = {}) => ({ ...rexEnv, PATH: `${bin}:${rexEnv.PATH}`, ...env });

function freshProject(name) {
  const dir = mkdtempSync(join(dirname(dirs.projectDir), `${name}-`));
  writeFileSync(join(dir, "hive.yml"), "dashboard: false\n");
  return dir;
}

const projectOf = (dir) => db.prepare("SELECT id, name, path FROM projects WHERE path = ?").get(dir);

async function hook(actor, event, body, env = {}) {
  const { code, stderr } = await runNode(HOOK, [event], { dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: actor, HIVE_LEAD: "1", ...env }, stdin: body });
  assert.equal(code, 0, stderr);
}

const payload = (name, extra) => JSON.stringify({ ...fixture(name), ...extra });

async function rexLead(name, size = { columns: 132, rows: 40 }) {
  const dir = freshProject(name);
  const started = await runCli(["lead", dir, "--detach"], { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp, env: withClaude({ HIVE_TERMINAL: "rex" }) });
  assert.equal(started.code, 0, started.stdout + started.stderr);
  const project = projectOf(dir);
  const lead = leadRow(db, project.id);
  assert.match(lead.tmux_target, /^block:/);
  const block = fake.state().blocks[lead.tmux_target];
  rexApi(process.env.REX_SERVER, "block.method", { session_id: block.session_id, block_id: lead.tmux_target, method: "resize", args: size });
  const transcript = join(dir, "lead.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { id: "m0", model: "claude" } })}\n`);
  await hook(lead.actor_id, "prompt", payload("lead-claude-prompt.json", { session_id: SESSION, transcript_path: transcript }));
  await hook(lead.actor_id, "stop", payload("lead-claude-stop.json", { session_id: SESSION, transcript_path: transcript }));
  db.exec("UPDATE lead_turn_state SET human_prompt_at = datetime('now', '-10 minutes'); UPDATE agent_state_log SET created_at = datetime('now', '-10 minutes')");
  const pad = db.prepare(`INSERT INTO pads (project_id, name, content) VALUES (?, ?, ?) RETURNING id, revision`).get(project.id, handoff.HANDOFF_PAD_NAME, PAD);
  return { dir, project, lead, transcript, pad, window: block.window_id };
}

async function handOff(ctx, env = {}) {
  const armed = await runCli(["lead-handoff", "--pad", String(ctx.pad.id), "--revision", String(ctx.pad.revision)], {
    cwd: ctx.dir,
    dataDir: dirs.dataDir,
    tmp: dirs.tmp,
    env: withClaude({ HIVE_AGENT_ID: ctx.lead.actor_id, HIVE_LEAD: "1", REX_BLOCK: ctx.lead.tmux_target, ...env }),
  });
  assert.equal(armed.code, 0, armed.stdout + armed.stderr);
  const row = handoff.readActiveHandoff(ctx.lead.id);
  assert.equal(row.state, "grace");
  writeFileSync(join(ctx.dir, "successor-prompt.json"), payload("lead-claude-prompt.json", { session_id: SUCCESSOR, transcript_path: ctx.transcript, prompt: handoff.successorPrompt(row) }));
  writeFileSync(join(ctx.dir, "successor-stop.json"), payload("lead-claude-stop.json", { session_id: SUCCESSOR, transcript_path: ctx.transcript }));
  writeFileSync(join(ctx.dir, "successor.flag"), "");
  db.prepare("UPDATE lead_handoffs SET grace_started_at = datetime('now', '-10 minutes') WHERE id = ?").run(row.id);
  return row.id;
}

const handoffRow = (id) => handoff.readHandoff(id);
const layerOf = (window, block) => fake.state().windows.find((w) => w.window_id === window)?.layers.find((l) => l.blocks.includes(block));

const SHELL = "com.superlogical.terminal.shell";
const apiCalls = () =>
  fake.calls().filter((c) => c.argv[0] !== "__fake").map((c) => {
    const i = c.argv.indexOf("call");
    return i >= 0 ? { method: c.argv[i + 1], params: JSON.parse(c.argv[i + 2] ?? "{}") } : null;
  }).filter(Boolean);
const graceLog = (id) => {
  const file = join(dirs.dataDir, `lead-handoff-${id}.log`);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};
const settled = (id) => until(() => ["failed", "ambiguous", "completed"].includes(handoffRow(id).state), 30_000, 100, `handoff settled: ${JSON.stringify(handoffRow(id))}`);

function blocksBefore() {
  const state = fake.state();
  return { open: new Set(Object.keys(state.blocks)), closed: state.closed.length };
}

function newlyClosed(before) {
  const state = fake.state();
  return state.closed.slice(before.closed).filter((id) => !before.open.has(id) && !state.blocks[id]);
}

function assertRolledBack(ctx, before, id) {
  const row = leadRow(db, ctx.project.id);
  assert.equal(row.tmux_target, ctx.lead.tmux_target, "the lead row still names the old block");
  assert.ok(fake.state().blocks[ctx.lead.tmux_target], "the old block is still open");
  assert.equal(handoffRow(id).pane_target, ctx.lead.tmux_target);
  assert.equal(newlyClosed(before).length, 1, "the one new block was closed");
  assert.equal(apiCalls().filter((c) => c.method === "session.new_block").length - before.newBlocks, 1);
}

describe("Rex lead handoff", () => {
  it("handoff on Rex replaces the lead block in place, beside a split worker, and moves the lead row to it", async () => {
    const ctx = await rexLead("rex-handoff-place");
    const old = ctx.lead.tmux_target;
    const session = fake.state().blocks[old].session_id;
    const worker = rexApi(process.env.REX_SERVER, "session.new_split", {
      session_id: session, anchor_id: old, direction: "horizontal", side: "after", focus: false,
      layout: { block: { flavor: SHELL, label: "worker-beside", options: { shell: "none", login: false, command: ["/bin/sleep", "600"] } } },
    }).block_ids[0];
    assert.deepEqual(layerOf(ctx.window, old).blocks, [old, worker]);
    const id = await handOff(ctx);
    await until(() => handoffRow(id).state === "completed", 30_000, 100, `handoff completed: ${JSON.stringify(handoffRow(id))}`);
    const row = leadRow(db, ctx.project.id);
    assert.notEqual(row.tmux_target, old);
    assert.match(row.tmux_target, /^block:/);
    assert.equal(handoffRow(id).pane_target, row.tmux_target);
    const state = fake.state();
    assert.equal(state.blocks[old], undefined, "the old block is closed");
    assert.ok(state.closed.includes(old));
    const successor = state.blocks[row.tmux_target];
    assert.equal(successor.window_id, ctx.window, "same tab");
    assert.deepEqual(layerOf(ctx.window, row.tmux_target).blocks, [row.tmux_target, worker], "the new block takes the old one's place before the worker");
    assert.equal(successor.label, `${ctx.project.name}/lead`);
    assert.deepEqual(successor.size, { columns: 132, rows: 40 }, "sized to the old block");
    assert.equal(successor.options.login, false);
    assert.equal(successor.options.shell, "none");
    assert.equal(successor.command[0], "/usr/bin/env");
    assert.ok(successor.command.includes(`HIVE_AGENT_ID=${ctx.lead.actor_id}`));
    assert.equal(row.pane_pid, String(successor.child_pid));
    assert.equal(handoffRow(id).successor_pane_pid, row.pane_pid);
    fakeRexDo(dirs.tmp, "closeBlock", { block_id: worker });
  });

  it("wakes and standing watches to the lead survive a Rex handoff, held until the successor's first Stop and typed once", async () => {
    const ctx = await rexLead("rex-handoff-wakes");
    const old = ctx.lead.tmux_target;
    const actor = ctx.lead.actor_id;
    const watch = db
      .prepare(
        `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, watch_scope)
         VALUES (?, ?, 'standing watch', 'idle_any', ?, ?, 'project') RETURNING id`,
      )
      .get(ctx.project.id, actor, actor, old).id;
    const pending = (body, parent) =>
      db
        .prepare(
          `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, parent_wake_id)
           VALUES (?, ?, ?, 'delay', ?, ?, datetime('now', '-16 minutes'), ?) RETURNING id`,
        )
        .get(ctx.project.id, actor, body, actor, old, parent).id;
    const roster = pending("REXROSTER crew [idle]", watch);
    const oneShot = pending("REXONESHOT check the crew", null);
    const wake = (wid) => db.prepare("SELECT * FROM wakes WHERE id = ?").get(wid);
    const id = await handOff(ctx);
    let ticksWhileStarted = 0;
    const typedBeforeCompleted = [];
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && handoffRow(id).state !== "completed") {
      const before = handoffRow(id).state;
      await tick();
      if (before === "started" && handoffRow(id).state === "started") {
        ticksWhileStarted++;
        for (const wid of [roster, oneShot]) if (wake(wid).typed_at !== null) typedBeforeCompleted.push(wid);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(handoffRow(id).state, "completed", JSON.stringify(handoffRow(id)));
    assert.ok(ticksWhileStarted > 0, "the scheduler ticked while the successor was booting");
    assert.deepEqual(typedBeforeCompleted, [], "nothing is typed while the handoff is only started");
    const successor = leadRow(db, ctx.project.id).tmux_target;
    assert.notEqual(successor, old);
    assert.deepEqual(layerOf(ctx.window, successor).blocks, [successor], "a lead alone in its tab keeps the tab");
    for (const wid of [watch, roster, oneShot]) assert.equal(wake(wid).deliver_pane, successor, `wake ${wid} follows the lead to its new block`);
    await until(async () => {
      await tick();
      return wake(roster).typed_at !== null && wake(oneShot).typed_at !== null;
    }, 20_000, 200, `both wakes typed: ${JSON.stringify([wake(roster), wake(oneShot)])}`);
    for (let i = 0; i < 3; i++) await tick();
    const received = join(ctx.dir, "received.txt");
    await until(() => existsSync(received) && /REXROSTER/.test(readFileSync(received, "utf8")) && /REXONESHOT/.test(readFileSync(received, "utf8")), 5000);
    const text = readFileSync(received, "utf8");
    assert.equal(text.split("REXROSTER").length - 1, 1, "the roster is typed exactly once");
    assert.equal(text.split("REXONESHOT").length - 1, 1, "the one-shot is typed exactly once");
    assert.equal(wake(watch).cancelled_at, null, "the standing watch is still standing");
  });

  it("a close that fails after the move leaves the old block as a labelled orphan with no row, listed by rexUnownedBlocks, and the lead row on the new block", async () => {
    const ctx = await rexLead("rex-handoff-orphan");
    const old = ctx.lead.tmux_target;
    const id = await handOff(ctx, { FAKE_REX_FAIL_ON: "block.close" });
    await until(() => ["started", "completed"].includes(handoffRow(id).state), 30_000, 100, `handoff started: ${JSON.stringify(handoffRow(id))}`);
    const row = leadRow(db, ctx.project.id);
    assert.notEqual(row.tmux_target, old);
    const state = fake.state();
    assert.ok(state.blocks[old], "the old block was never closed");
    assert.equal(state.blocks[old].label, `${ctx.project.name}/lead`);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE tmux_target = ?").get(old).n, 0, "no row points at the old block");
    assert.deepEqual(layerOf(ctx.window, row.tmux_target).blocks, [row.tmux_target, old], "the new block sits where the old one was");
    const orphans = rexUnownedBlocks();
    assert.ok(orphans !== null);
    assert.deepEqual(orphans.filter((o) => o.label.startsWith(`${ctx.project.name}/`)), [{ block: old, label: `${ctx.project.name}/lead` }]);
    await until(() => graceLog(id).includes(old), 10_000, 50, "the grace owner logged the orphan");
    const closes = apiCalls().filter((c) => c.method === "block.close" && c.params.block_id === old).length;
    assert.equal(closes, 3, "the close is retried three times");
    assert.match(graceLog(id), new RegExp(`predecessor block ${old} could not be closed and is left running with no row`));
    fakeRexDo(dirs.tmp, "closeBlock", { block_id: old });
  });

  it("after a failed close, a hook from the orphaned predecessor block leaves the successor's turn state intact, while the successor's own hook still lands", async () => {
    const ctx = await rexLead("rex-handoff-fence");
    const old = ctx.lead.tmux_target;
    const id = await handOff(ctx, { FAKE_REX_FAIL_ON: "block.close" });
    await until(() => handoffRow(id).state === "completed", 30_000, 100, `handoff completed: ${JSON.stringify(handoffRow(id))}`);
    const successor = leadRow(db, ctx.project.id).tmux_target;
    assert.ok(fake.state().blocks[old], "the predecessor block is still running");
    const turn = () => db.prepare("SELECT session_id, state, pane_pid FROM lead_turn_state WHERE agent_id = ?").get(ctx.lead.id);
    const logs = () => db.prepare("SELECT COUNT(*) AS n FROM agent_state_log WHERE actor_id = ?").get(ctx.lead.actor_id).n;
    const settledTurn = turn();
    assert.equal(settledTurn.session_id, SUCCESSOR);
    assert.notEqual(settledTurn.state, "working");
    const logged = logs();
    await hook(ctx.lead.actor_id, "prompt", payload("lead-claude-prompt.json", { session_id: SESSION, transcript_path: ctx.transcript }), { REX_BLOCK: old });
    assert.deepEqual(turn(), settledTurn, "the predecessor's prompt changed nothing");
    assert.equal(logs(), logged, "and was not logged as accepted");
    await hook(ctx.lead.actor_id, "prompt", payload("lead-claude-prompt.json", { session_id: SUCCESSOR, transcript_path: ctx.transcript }), { REX_BLOCK: successor });
    assert.equal(turn().state, "working", "positive control: the successor's own block is heard");
    fakeRexDo(dirs.tmp, "closeBlock", { block_id: old });
  });

  it("a lead hook from another block is still processed when the row's recorded block runs an unrelated program (reissued, not owned)", async () => {
    const dir = freshProject("rex-hook-reissued");
    const project = db.prepare("INSERT INTO projects (name, path) VALUES ('rex-hook-reissued', ?) RETURNING id").get(dir).id;
    const session = rexApi(process.env.REX_SERVER, "session.create", { label: "rex-hook-reissued" }).session_id;
    const blockRunning = (label, command) =>
      rexApi(process.env.REX_SERVER, "session.new_window", {
        session_id: session, window_label: label, focus: false,
        layout: { block: { flavor: SHELL, label, options: { shell: "none", login: false, command } } },
      }).block_ids[0];
    const stale = blockRunning("rex-hook-reissued/stale", ["/bin/sleep", "600"]);
    const fresh = blockRunning("rex-hook-reissued/lead", ["/bin/sleep", "600"]);
    const lead = db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd, status)
         VALUES (?, 'lead:reissued', 'lead', 'lead', ?, ?, ?, 'claude', ?, 'running') RETURNING *`,
      )
      .get(project, stale, `rex:${process.env.REX_SERVER}`, String(fake.state().blocks[stale].child_pid), dir);
    const { rowOwnership } = await import("../dist/terminal.js");
    assert.equal(rowOwnership(lead), "reissued", "the row's block is alive but not the row's program");
    const logs = () => db.prepare("SELECT COUNT(*) AS n FROM agent_state_log WHERE actor_id = 'lead:reissued'").get().n;
    const before = logs();
    await hook("lead:reissued", "prompt", payload("lead-claude-prompt.json", { session_id: SESSION, transcript_path: join(dir, "t.jsonl") }), { REX_BLOCK: fresh });
    assert.equal(logs(), before + 1, "the hook was accepted and logged");
    assert.equal(db.prepare("SELECT state FROM lead_turn_state WHERE agent_id = ?").get(lead.id)?.state, "working", "and the lead's turn state took it");
    for (const block of [stale, fresh]) fakeRexDo(dirs.tmp, "closeBlock", { block_id: block });
  });

  it("a move_block that fails closes the new block, fails the handoff, and leaves the lead row and old block as they were", async () => {
    const ctx = await rexLead("rex-handoff-move-fails");
    const before = { ...blocksBefore(), newBlocks: apiCalls().filter((c) => c.method === "session.new_block").length };
    const id = await handOff(ctx, { FAKE_REX_FAIL_ON: "session.move_block" });
    await settled(id);
    assert.equal(handoffRow(id).state, "failed");
    assert.match(handoffRow(id).failure, /injected failure on session\.move_block/);
    assert.equal(leadRow(db, ctx.project.id).pane_pid, ctx.lead.pane_pid, "the lead pid is unchanged");
    assertRolledBack(ctx, before, id);
  });

  it("a lead pid that changes before the record rolls the respawn back and fails the handoff", async () => {
    const ctx = await rexLead("rex-handoff-pid-moves");
    const before = { ...blocksBefore(), newBlocks: apiCalls().filter((c) => c.method === "session.new_block").length };
    const moves = apiCalls().filter((c) => c.method === "session.move_block").length;
    const id = await handOff(ctx, { FAKE_REX_SLEEP_ON: "session.move_block:2000" });
    await until(() => apiCalls().filter((c) => c.method === "session.move_block").length > moves, 30_000, 50, "the move started");
    db.prepare("UPDATE agents SET pane_pid = '1' WHERE id = ?").run(ctx.lead.id);
    await settled(id);
    assert.equal(handoffRow(id).state, "failed");
    assert.match(handoffRow(id).failure, /the lead row moved before the successor block could be recorded/);
    assert.equal(leadRow(db, ctx.project.id).pane_pid, "1");
    assertRolledBack(ctx, before, id);
  });

  it("a Rex timeout before the record fails the handoff rather than leaving it ambiguous", async () => {
    const ctx = await rexLead("rex-handoff-timeout");
    const before = { ...blocksBefore(), newBlocks: apiCalls().filter((c) => c.method === "session.new_block").length };
    const id = await handOff(ctx, { FAKE_REX_SLEEP_ON: "session.move_block:6000", HIVE_REX_TIMEOUT: "2s" });
    await settled(id);
    assert.equal(handoffRow(id).state, "failed", JSON.stringify(handoffRow(id)));
    assert.match(handoffRow(id).failure, /session\.move_block|timeout|did not finish/);
    assert.equal(leadRow(db, ctx.project.id).pane_pid, ctx.lead.pane_pid);
    assertRolledBack(ctx, before, id);
  });
});

describe("Rex quiet messages across a handoff", () => {
  const sinkBin = join(dirs.tmp, "sink-bin");
  mkdirSync(sinkBin, { recursive: true });
  writeFileSync(join(sinkBin, "claude"), '#!/bin/sh\nexec cat > "$SINK"\n');
  chmodSync(join(sinkBin, "claude"), 0o755);

  function sinkBlock(session, window, sink, anchor) {
    const layout = { block: { flavor: SHELL, label: "twin/lead", options: { shell: "none", login: false, command: ["/usr/bin/env", `SINK=${sink}`, join(sinkBin, "claude")] } } };
    const reply = anchor
      ? rexApi(process.env.REX_SERVER, "session.new_split", { session_id: session, anchor_id: anchor, direction: "horizontal", side: "after", layout, focus: false })
      : rexApi(process.env.REX_SERVER, "session.new_window", { session_id: session, window_label: "twin", layout, focus: false });
    const block = reply.block_ids[0];
    return { block, pid: String(fake.state().blocks[block].child_pid), window: reply.window_id ?? window };
  }

  it("held wakes and messages accepted for the old block reach the handed-off successor block once and never the predecessor", async () => {
    const dir = freshProject("rex-twin");
    const project = db.prepare("INSERT INTO projects (name, path) VALUES ('rex-twin', ?) RETURNING id").get(dir).id;
    db.prepare("INSERT INTO kv (project_id, key, value, updated_by) VALUES (?, 'terminal:rex:in-use', '1', 'test')").run(project);
    const session = rexApi(process.env.REX_SERVER, "session.create", { label: "rex-twin" }).session_id;
    const predecessorSink = join(dir, "predecessor.sink");
    const successorSink = join(dir, "successor.sink");
    writeFileSync(predecessorSink, "");
    writeFileSync(successorSink, "");
    const first = sinkBlock(session, "", predecessorSink);
    const transcript = join(dir, "lead.jsonl");
    writeFileSync(transcript, Array.from({ length: 12 }, (_, i) => JSON.stringify({ type: "assistant", message: { id: `m${i}`, model: "claude" } })).join("\n") + "\n");
    const lead = db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd, status, created_at)
         VALUES (?, 'lead:twin', 'lead', 'lead', ?, ?, ?, 'claude', ?, 'running', datetime('now', '-60 seconds')) RETURNING *`,
      )
      .get(project, first.block, `rex:${process.env.REX_SERVER}`, first.pid, dir);
    const worker = db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, pane_pid, command, cwd, status)
         VALUES (?, 'agent:twin-w', 'w', 'agent', 'block:none', '1', 'claude', ?, 'running') RETURNING *`,
      )
      .get(project, dir);
    await hook("lead:twin", "prompt", payload("lead-claude-prompt.json", { session_id: SESSION, transcript_path: transcript }));
    await handoff.driveLeadHandoff("lead:twin", () => ({ warn: 3, stop: 10, auto_handoff: true }));
    const row = handoff.readActiveHandoff(lead.id);
    assert.equal(handoff.readHandoffGate(lead.id).holdAutomation, true);
    db.exec("UPDATE agent_state_log SET created_at = datetime('now', '-10 minutes')");

    const receipt = await sendQuietLeadMessage({
      projectId: project, fromActor: worker.actor_id, target: db.prepare("SELECT * FROM agents WHERE id = ?").get(lead.id),
      text: "held for the rex successor", submit: true,
    });
    assert.equal(receipt.pending, true, JSON.stringify(receipt));
    assert.match(JSON.parse(db.prepare("SELECT target_identity FROM agent_messages WHERE to_agent_id = ?").get(lead.id).target_identity).tmux_target, new RegExp(first.block));
    const notice = db
      .prepare(
        `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at)
         VALUES (?, 'agent:twin-w', 'rex crew notice', 'delay', 'lead:twin', ?, datetime('now')) RETURNING id`,
      )
      .get(project, first.block).id;
    await tick();
    await retryQuietLeadMessages(null);
    assert.equal(readFileSync(predecessorSink, "utf8"), "", "nothing typed into the predecessor during the hold");

    const next = sinkBlock(session, first.window, successorSink, first.block);
    fakeRexDo(dirs.tmp, "closeBlock", { block_id: first.block });
    db.prepare("UPDATE agents SET tmux_target = ?, pane_pid = ? WHERE id = ?").run(next.block, next.pid, lead.id);
    db.prepare("UPDATE wakes SET deliver_pane = ? WHERE id = ?").run(next.block, notice);
    handoff.casHandoff(row.id, [row.state], { state: "completed", pane_target: next.block, successor_pane_pid: next.pid });

    for (let i = 0; i < 3; i++) {
      await tick();
      await retryQuietLeadMessages(null);
    }
    await until(() => readFileSync(successorSink, "utf8").includes("rex crew notice") && readFileSync(successorSink, "utf8").includes("held for the rex successor"), 5000);
    const typed = readFileSync(successorSink, "utf8");
    assert.equal(typed.split("held for the rex successor").length - 1, 1);
    assert.equal(typed.split("rex crew notice").length - 1, 1);
    assert.equal(db.prepare("SELECT delivery_status FROM agent_messages WHERE to_agent_id = ?").get(lead.id).delivery_status, "complete");
    fakeRexDo(dirs.tmp, "closeBlock", { block_id: next.block });
  });
});
