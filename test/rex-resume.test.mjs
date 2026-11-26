import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { CLI, clearHiveEnv, isolateTmux, leadRow, McpClient, runCli, scratchDirs } from "./helpers.mjs";
import { fakeRexDo, isolateRex, waitFor } from "./rex-helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("rex resume tests");
const dirs = scratchDirs();
const fake = isolateRex(dirs.tmp);
clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const rexEnv = Object.fromEntries(Object.entries(fake.env).filter(([k]) => !k.startsWith("HIVE_")));

const { db, migrate } = await import("../dist/db.js");
migrate();
const terminal = await import("../dist/terminal.js");
const { REX_RESUME_SCRIPT } = await import("../dist/rexResume.js");
const { rexApi } = await import("../dist/rexCli.js");

const clients = [];
after(async () => {
  for (const client of clients) await client.close();
  fake.cleanup();
  cleanupTmux();
});

const DUMPS = join(dirs.tmp, "dumps");
mkdirSync(DUMPS, { recursive: true });
const BIN = join(dirs.tmp, "claude-bin");
mkdirSync(BIN, { recursive: true });
const CLAUDE = join(BIN, "claude");
writeFileSync(
  CLAUDE,
  `#!${process.execPath}\n` +
    `require("fs").writeFileSync(${JSON.stringify(DUMPS)} + "/" + (process.env.HIVE_AGENT_NAME || "anon") + "-" + process.pid + ".json", ` +
    "JSON.stringify({ env: process.env, argv: process.argv.slice(2) }));\nsetInterval(() => {}, 1 << 30);\n",
);
chmodSync(CLAUDE, 0o755);
const CLAUDE_PATH = `${BIN}:${rexEnv.PATH}`;
const withClaude = (env = {}) => ({ ...rexEnv, PATH: CLAUDE_PATH, ...env });

const dumpsOf = (name) =>
  readdirSync(DUMPS)
    .filter((f) => f.startsWith(`${name}-`))
    .map((f) => ({ pid: f.slice(name.length + 1, -5), ...JSON.parse(readFileSync(join(DUMPS, f), "utf8")) }));

const REPORT = /\x1b\]7577;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

function reportsIn(block) {
  const text = readFileSync(join(block.dir, "output"), "utf8");
  return [...text.matchAll(REPORT)].map(([, body]) => {
    const cut = body.lastIndexOf(":mac=");
    const head = body.slice(0, cut);
    const pairs = Object.fromEntries(head.split(":").map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
    return {
      pid: Number(pairs.pid),
      argv: (pairs.argv ?? "").split(",").filter(Boolean).map((a) => Buffer.from(a, "base64").toString("utf8")),
      macOk: createHash("sha256").update(`${head}:${block.token}`).digest("hex") === body.slice(cut + 5),
    };
  });
}

const rowById = (id) => db.prepare("SELECT * FROM agents WHERE id = ?").get(id);

async function startProject(name) {
  const dir = mkdtempSync(join(dirname(dirs.projectDir), `${name}-`));
  const result = await runCli(["lead", dir, "--detach"], { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp, env: withClaude({ HIVE_TERMINAL: "rex" }) });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const project = db.prepare("SELECT id, name, path FROM projects WHERE path = ?").get(dir);
  const lead = leadRow(db, project.id);
  const mcp = new McpClient({ cwd: dir, dataDir: dirs.dataDir, env: withClaude({ HIVE_AGENT_ID: lead.actor_id, HIVE_SPAWN_READY_MS: "300" }) });
  clients.push(mcp);
  await mcp.start();
  const workerName = `${name}-w`;
  await mcp.call("agent_spawn", { name: workerName, command: CLAUDE, placement: "split" });
  const worker = db.prepare("SELECT * FROM agents WHERE project_id = ? AND name = ?").get(project.id, workerName);
  await waitFor(() => dumpsOf(workerName).length > 0 && dumpsOf("lead").some((d) => d.pid === lead.pane_pid));
  return { dir, project, lead, worker };
}

function giveSessions({ lead, worker }) {
  db.prepare("UPDATE agents SET session_id = ? WHERE id = ?").run(`sess-${worker.id}`, worker.id);
  db.prepare("INSERT OR REPLACE INTO lead_turn_state (agent_id, pane_pid, session_id) VALUES (?, ?, ?)").run(lead.id, lead.pane_pid, `sess-${lead.id}`);
}

function runResume(agentId, block, shellMarker) {
  const shell = join(dirs.tmp, "marker-shell");
  writeFileSync(shell, `#!/bin/sh\necho ${shellMarker}\n`);
  chmodSync(shell, 0o755);
  const run = spawnSync("/bin/sh", ["-c", REX_RESUME_SCRIPT, "hive", process.execPath, CLI, "__rex-resume", String(agentId), "--data-dir", dirs.dataDir], {
    env: { ...fake.env, REX_BLOCK: block, SHELL: shell },
    encoding: "utf8",
  });
  return `${run.stdout}${run.stderr}`;
}

describe("Rex restart survival", () => {
  it("hive panes never expose OSC7577_TOKEN to the harness", async () => {
    const { lead, worker } = await startProject("rex-token");
    const state = fake.state();
    for (const row of [lead, worker]) {
      assert.match(state.blocks[row.tmux_target].token ?? "", /^[A-Za-z0-9_-]{22,64}$/, "the fake gave the block a token");
      const dumps = dumpsOf(row.name).filter((d) => d.pid === row.pane_pid);
      assert.equal(dumps.length, 1, `${row.name} dumped its env once`);
      assert.equal(dumps[0].env.OSC7577_TOKEN, undefined, `${row.name} must not inherit the token`);
      assert.ok(!JSON.stringify(dumps[0]).includes(state.blocks[row.tmux_target].token), "the token appears nowhere in the harness env or argv");
    }
  });

  it("rex launch emits one resume record naming hive __rex-resume <id>", async () => {
    const { lead, worker } = await startProject("rex-record");
    const state = fake.state();
    for (const row of [lead, worker]) {
      const block = state.blocks[row.tmux_target];
      const reports = reportsIn(block);
      assert.equal(reports.length, 1, JSON.stringify(reports));
      assert.equal(reports[0].macOk, true, "the mac is sha256 of the body, a colon and the block's token");
      assert.equal(reports[0].pid, block.child_pid, "the record names the harness's own pid");
      const argv = reports[0].argv;
      assert.deepEqual(argv.slice(0, 4), ["/bin/sh", "-c", REX_RESUME_SCRIPT, "hive"]);
      assert.deepEqual(argv.slice(4), [process.execPath, CLI, "__rex-resume", String(row.id), "--data-dir", dirs.dataDir]);
      assert.equal(terminal.rowOwnership(rowById(row.id)), "live", "ownership reads the exec'd harness, not the launch shell");
    }
  });

  it("__rex-resume for a closed row or a different block refuses and runs a shell", async () => {
    const { worker } = await startProject("rex-refuse");
    db.prepare("UPDATE agents SET session_id = 'sess-refuse' WHERE id = ?").run(worker.id);
    const other = Object.keys(fake.state().blocks).find((b) => b !== worker.tmux_target);
    const wrongBlock = runResume(worker.id, other, "SHELL-RAN-1");
    assert.match(wrongBlock, new RegExp(`hive: not resuming ${worker.name}: its row records block ${worker.tmux_target}, not this block ${other}`));
    assert.match(wrongBlock, /SHELL-RAN-1/);
    assert.equal(rowById(worker.id).pane_pid, worker.pane_pid, "a refused resume records nothing");

    db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(worker.id);
    const closed = runResume(worker.id, worker.tmux_target, "SHELL-RAN-2");
    assert.match(closed, new RegExp(`hive: not resuming ${worker.name}: its row is closed`));
    assert.match(closed, /SHELL-RAN-2/);
    assert.equal(rowById(worker.id).pane_pid, worker.pane_pid);
    assert.equal(dumpsOf(worker.name).length, 1, "no second harness was launched");
  });

  it("__rex-resume restores a worker with HIVE_AGENT_ID and HIVE_PROJECT_LOCK", async () => {
    const started = await startProject("rex-restore");
    const { lead, worker } = started;
    giveSessions(started);
    const blocksBefore = Object.keys(fake.state().blocks).sort();
    fakeRexDo(dirs.tmp, "restartServer", { trust: true, env: { PATH: CLAUDE_PATH } });
    assert.deepEqual(Object.keys(fake.state().blocks).sort(), blocksBefore, "a restart keeps every block id");
    await waitFor(() => dumpsOf(worker.name).length === 2 && dumpsOf("lead").some((d) => d.pid !== lead.pane_pid && d.env.HIVE_AGENT_ID === lead.actor_id), { timeoutMs: 15000 });

    const state = fake.state();
    const resumed = dumpsOf(worker.name).find((d) => d.pid !== worker.pane_pid);
    const row = rowById(worker.id);
    assert.equal(row.status, "running");
    assert.equal(row.tmux_target, worker.tmux_target);
    assert.equal(row.pane_pid, resumed.pid, "the row records the restored harness's pid");
    assert.equal(String(state.blocks[row.tmux_target].child_pid), resumed.pid, "which is the block's own process");
    assert.notEqual(row.pane_started_at, null);
    assert.equal(resumed.env.HIVE_AGENT_ID, worker.actor_id);
    assert.equal(resumed.env.HIVE_PROJECT_LOCK, "1");
    assert.equal(resumed.env.OSC7577_TOKEN, undefined);
    assert.deepEqual(resumed.argv.slice(-2), ["--resume", `sess-${worker.id}`]);
    assert.equal(terminal.rowOwnership(row), "live");
    assert.equal(reportsIn(state.blocks[row.tmux_target]).filter((r) => r.macOk).length, 1, "the resumed harness reported again under the new token");

    const leadNow = rowById(lead.id);
    const leadDump = dumpsOf("lead").find((d) => d.pid === leadNow.pane_pid);
    assert.ok(leadDump, "the lead row was re-pointed to its restored process");
    assert.equal(leadNow.tmux_target, lead.tmux_target);
    assert.equal(leadDump.env.HIVE_LEAD, "1");
    assert.deepEqual(leadDump.argv.slice(-2), ["--resume", `sess-${lead.id}`]);
    assert.equal(terminal.rowOwnership(leadNow), "live");
  });

  it("__rex-resume brings a worker the janitor marked lost mid-restart back to running in its own block", async () => {
    const { worker } = await startProject("rex-lost");
    db.prepare("UPDATE agents SET session_id = 'sess-lost' WHERE id = ?").run(worker.id);
    process.kill(Number(worker.pane_pid), "SIGKILL");
    await waitFor(() => {
      try {
        process.kill(Number(worker.pane_pid), 0);
        return false;
      } catch {
        return true;
      }
    });
    db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now'), recovery_state = 'pending' WHERE id = ?").run(worker.id);
    const child = spawn("/bin/sh", ["-c", REX_RESUME_SCRIPT, "hive", process.execPath, CLI, "__rex-resume", String(worker.id), "--data-dir", dirs.dataDir], {
      env: { ...fake.env, REX_BLOCK: worker.tmux_target },
      stdio: "ignore",
      detached: true,
    });
    try {
      await waitFor(() => dumpsOf(worker.name).some((d) => d.pid === String(child.pid)), { timeoutMs: 10000 });
      const row = rowById(worker.id);
      assert.equal(row.status, "running");
      assert.equal(row.recovery_state, "");
      assert.equal(row.pane_pid, String(child.pid), "the pid recorded is the shell Rex started, which exec'd the harness");
      const dump = dumpsOf(worker.name).find((d) => d.pid === String(child.pid));
      assert.equal(dump.env.HIVE_PROJECT_LOCK, "1");
      assert.equal(dump.env.HIVE_AGENT_ID, worker.actor_id);
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      db.prepare("UPDATE agents SET status = 'closed' WHERE id = ?").run(worker.id);
    }
  });

  it("without the trust rule, restored blocks are shells and their rows are reaped", async () => {
    const started = await startProject("rex-untrusted");
    const { dir, lead, worker } = started;
    giveSessions(started);
    fakeRexDo(dirs.tmp, "restartServer", { trust: false, env: { PATH: CLAUDE_PATH } });
    const state = fake.state();
    assert.ok(state.blocks[worker.tmux_target] && state.blocks[lead.tmux_target], "the blocks themselves are restored");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(dumpsOf(worker.name).length, 1, "no harness ran in the restored worker block");
    assert.equal(terminal.rowOwnership(rowById(worker.id)), "reissued");
    db.prepare("UPDATE agents SET created_at = datetime('now', '-1 hour') WHERE id = ?").run(worker.id);
    const status = await runCli(["status"], { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp, env: rexEnv });
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.equal(rowById(worker.id).status, "closed", "the janitor reaps the worker row");
    assert.equal(rowById(worker.id).recovery_state, "pending", "as a lost worker crew-restore can bring back");
    assert.ok(existsSync(state.blocks[worker.tmux_target].dir));
  });

  it("a block still inside hive's launch shell reads unknown, while one running another program reads reissued", () => {
    const blockRunning = (label, command) => {
      const made = rexApi(process.env.REX_SERVER, "session.create", {
        label: `s-${label}`,
        initial_windows: [{ window_label: label, layout: { block: { flavor: "com.superlogical.terminal.shell", label, options: { shell: "none", login: false, command } } } }],
      });
      const block = made.initial_windows[0].block_ids[0];
      return { tmux_target: block, tmux_socket: `rex:${process.env.REX_SERVER}`, pane_pid: String(fake.state().blocks[block].child_pid), command: "claude --name w" };
    };
    assert.equal(terminal.rowOwnership(blockRunning("launching", ["/bin/sh", "-c", "sleep 600; true"])), "unknown");
    assert.equal(terminal.rowOwnership(blockRunning("other", ["sleep", "600"])), "reissued");
  });

  it("hive setup --rex-resume prints the rule and writes nothing", async () => {
    const home = mkdtempSync(join(dirs.tmp, "home-"));
    const config = join(home, ".config", "rex");
    mkdirSync(config, { recursive: true });
    const initLua = join(config, "init.lua");
    writeFileSync(initLua, "-- the user's own config\n");
    const bin = join(home, "bin");
    const result = await runCli(["setup", "--rex-resume"], { cwd: home, dataDir: dirs.dataDir, tmp: dirs.tmp, env: { ...rexEnv, HOME: home, HIVE_BIN_DIR: bin } });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /rex\.set\("resume\.trust\.hive", \{/);
    assert.ok(result.stdout.includes(`${JSON.stringify(CLI)}, "__rex-resume", rex.match.id, "--data-dir", ${JSON.stringify(dirs.dataDir)}`), result.stdout);
    assert.equal(readFileSync(initLua, "utf8"), "-- the user's own config\n");
    assert.deepEqual(readdirSync(home).sort(), [".config"]);
    assert.deepEqual(readdirSync(config), ["init.lua"]);
    assert.equal(existsSync(bin), false, "no dispatcher was written");
  });
});
