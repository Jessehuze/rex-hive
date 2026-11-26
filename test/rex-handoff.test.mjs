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

async function hook(actor, event, body) {
  const { code, stderr } = await runNode(HOOK, [event], { dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: actor, HIVE_LEAD: "1" }, stdin: body });
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

describe("Rex lead handoff", () => {
  it("handoff on Rex moves the lead row to a new block in the old block's place", async () => {
    const ctx = await rexLead("rex-handoff-place");
    const old = ctx.lead.tmux_target;
    assert.deepEqual(layerOf(ctx.window, old).blocks, [old], "the lead is alone in its tab");
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
    assert.deepEqual(layerOf(ctx.window, row.tmux_target).blocks, [row.tmux_target], "same position, and the tab survived the close");
    assert.equal(successor.label, `${ctx.project.name}/lead`);
    assert.deepEqual(successor.size, { columns: 132, rows: 40 }, "sized to the old block");
    assert.equal(successor.options.login, false);
    assert.equal(successor.options.shell, "none");
    assert.equal(successor.command[0], "/usr/bin/env");
    assert.ok(successor.command.includes(`HIVE_AGENT_ID=${ctx.lead.actor_id}`));
    assert.equal(row.pane_pid, String(successor.child_pid));
    assert.equal(handoffRow(id).successor_pane_pid, row.pane_pid);
  });

  it("wakes and standing watches to the lead survive a Rex handoff", async () => {
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
    await until(() => handoffRow(id).state === "completed", 30_000, 100, `handoff completed: ${JSON.stringify(handoffRow(id))}`);
    const successor = leadRow(db, ctx.project.id).tmux_target;
    assert.notEqual(successor, old);
    for (const wid of [watch, roster, oneShot]) assert.equal(wake(wid).deliver_pane, successor, `wake ${wid} follows the lead to its new block`);
    await until(async () => {
      await tick();
      return wake(roster).typed_at !== null && wake(oneShot).typed_at !== null;
    }, 20_000, 200, `both wakes typed: ${JSON.stringify([wake(roster), wake(oneShot)])}`);
    const received = join(ctx.dir, "received.txt");
    await until(() => existsSync(received) && /REXROSTER/.test(readFileSync(received, "utf8")) && /REXONESHOT/.test(readFileSync(received, "utf8")), 5000);
    const pastes = fake.state().blocks[successor].events.filter((e) => e.type === "paste").map((e) => e.payload.text).join("\n");
    assert.match(pastes, /REXONESHOT/, "delivered by paste into the new block");
    for (const wid of [roster, oneShot]) assert.ok(wake(wid).typed_at >= handoffRow(id).completed_at, `wake ${wid} waited for the successor's first completed turn`);
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
    fakeRexDo(dirs.tmp, "closeBlock", { block_id: old });
  });
});
