import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

function markerShell(shellMarker) {
  const shell = join(dirs.tmp, `marker-shell-${shellMarker}`);
  writeFileSync(shell, `#!/bin/sh\necho ${shellMarker}\n`);
  chmodSync(shell, 0o755);
  return shell;
}

const resumeArgs = (id) => [process.execPath, CLI, "__rex-resume", String(id), "--data-dir", dirs.dataDir];

function resumeEnv(block, extra = {}) {
  const env = { ...fake.env, ...extra };
  if (block === undefined) delete env.REX_BLOCK;
  else env.REX_BLOCK = block;
  return env;
}

function runResume(agentId, block, shellMarker) {
  const run = spawnSync("/bin/sh", ["-c", REX_RESUME_SCRIPT, "hive", ...resumeArgs(agentId)], {
    env: resumeEnv(block, { SHELL: markerShell(shellMarker) }),
    encoding: "utf8",
    timeout: 20000,
  });
  return `${run.stdout}${run.stderr}`;
}

function startResume(agentId, block) {
  return spawn("/bin/sh", ["-c", REX_RESUME_SCRIPT, "hive", ...resumeArgs(agentId)], { env: resumeEnv(block), stdio: "ignore", detached: true });
}

function killGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
}

async function killAndWait(pid) {
  process.kill(Number(pid), "SIGKILL");
  await waitFor(() => {
    try {
      process.kill(Number(pid), 0);
      return false;
    } catch {
      return true;
    }
  });
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

  it("__rex-resume refuses a live harness, a claimed pid equal to the recorded one, a missing REX_BLOCK and a non-decimal id", async () => {
    const { worker } = await startProject("rex-live");
    db.prepare("UPDATE agents SET session_id = 'sess-live' WHERE id = ?").run(worker.id);
    const refusal = (reason) => new RegExp(`hive: not resuming ${worker.name}: ${reason}`);

    const live = runResume(worker.id, worker.tmux_target, "SHELL-RAN-LIVE");
    assert.match(live, refusal(`its recorded process ${worker.pane_pid} is still running`));
    assert.match(live, /SHELL-RAN-LIVE/);

    const noBlock = runResume(worker.id, undefined, "SHELL-RAN-NOBLOCK");
    assert.match(noBlock, refusal("REX_BLOCK is not set, so this is not a restored Rex block"));
    assert.match(noBlock, /SHELL-RAN-NOBLOCK/);

    const hexId = `0x${worker.id.toString(16)}`;
    const hex = runResume(hexId, worker.tmux_target, "SHELL-RAN-HEX");
    assert.match(hex, new RegExp(`hive: not resuming agent ${hexId}: ${hexId} is not an agent id`));
    assert.match(hex, /SHELL-RAN-HEX/);

    let out = "";
    const child = spawn("/bin/sh", ["-c", `read _; ${REX_RESUME_SCRIPT}`, "hive", ...resumeArgs(worker.id)], {
      env: resumeEnv(worker.tmux_target, { SHELL: markerShell("SHELL-RAN-EQUAL") }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const closed = new Promise((r) => child.on("close", r));
    try {
      db.prepare("UPDATE agents SET pane_pid = ? WHERE id = ?").run(String(child.pid), worker.id);
      child.stdin.end("\n");
      await waitFor(() => /SHELL-RAN-EQUAL/.test(out) || dumpsOf(worker.name).length > 1, { timeoutMs: 15000 });
      assert.match(out, refusal(`its recorded process ${child.pid} is still running`));
      assert.match(out, /SHELL-RAN-EQUAL/);
      await closed;
    } finally {
      child.kill("SIGKILL");
      db.prepare("UPDATE agents SET pane_pid = ? WHERE id = ?").run(worker.pane_pid, worker.id);
    }
    const row = rowById(worker.id);
    assert.equal(row.pane_pid, worker.pane_pid, "no refused resume records a pid");
    assert.equal(row.agent_state, worker.agent_state, "nor resets the worker's state");
    assert.equal(row.resumed_at, worker.resumed_at);
    assert.equal(dumpsOf(worker.name).length, 1, "no second harness was launched");
  });

  it("__rex-resume refuses when the row changes before its pid is recorded, and runs a shell", async () => {
    const { worker } = await startProject("rex-race");
    db.prepare("UPDATE agents SET session_id = 'sess-race' WHERE id = ?").run(worker.id);
    await killAndWait(worker.pane_pid);
    db.exec(`CREATE TRIGGER rex_race_ignore BEFORE UPDATE OF pane_pid ON agents WHEN OLD.id = ${worker.id} BEGIN SELECT RAISE(IGNORE); END`);
    let out;
    try {
      out = runResume(worker.id, worker.tmux_target, "SHELL-RAN-RACE");
    } finally {
      db.exec("DROP TRIGGER rex_race_ignore");
    }
    assert.match(out, new RegExp(`hive: not resuming ${worker.name}: its row changed while it was being resumed`));
    assert.match(out, /SHELL-RAN-RACE/);
    assert.equal(rowById(worker.id).pane_pid, worker.pane_pid);
    assert.equal(dumpsOf(worker.name).length, 1, "no second harness was launched");
  });

  it("__rex-resume resumes a row whose recorded pid now belongs to an unrelated process, as after a reboot", async () => {
    const { worker } = await startProject("rex-reuse");
    db.prepare("UPDATE agents SET session_id = 'sess-reuse' WHERE id = ?").run(worker.id);
    await killAndWait(worker.pane_pid);
    const stranger = spawn("sleep", ["600"], { stdio: "ignore" });
    db.prepare("UPDATE agents SET pane_pid = ? WHERE id = ?").run(String(stranger.pid), worker.id);
    const child = startResume(worker.id, worker.tmux_target);
    try {
      await waitFor(() => dumpsOf(worker.name).some((d) => d.pid === String(child.pid)), { timeoutMs: 10000 });
      assert.equal(rowById(worker.id).pane_pid, String(child.pid), "the restored shell owns the row, not the stranger holding the old pid");
    } finally {
      killGroup(child);
      stranger.kill("SIGKILL");
      db.prepare("UPDATE agents SET status = 'closed' WHERE id = ?").run(worker.id);
    }
  });

  it("__rex-resume refuses a lead whose project directory is gone, before recording anything", async () => {
    const started = await startProject("rex-gone");
    const { dir, lead } = started;
    giveSessions(started);
    await killAndWait(lead.pane_pid);
    renameSync(dir, `${dir}-moved`);
    const out = runResume(lead.id, lead.tmux_target, "SHELL-RAN-GONE");
    assert.match(out, new RegExp(`hive: not resuming ${lead.name}: its working directory ${dir} is gone`));
    assert.match(out, /SHELL-RAN-GONE/);
    assert.equal(rowById(lead.id).pane_pid, lead.pane_pid, "the lead row still names its old process");
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
    await killAndWait(worker.pane_pid);
    db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now'), recovery_state = 'pending' WHERE id = ?").run(worker.id);

    const stranger = spawn("sleep", ["600"], { stdio: "ignore" });
    const forged = spawnSync(process.execPath, resumeArgs(worker.id).slice(1), {
      env: resumeEnv(worker.tmux_target, { HIVE_REX_RESUME_PID: String(stranger.pid) }),
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 20000,
    });
    stranger.kill("SIGKILL");
    assert.match(forged.stderr, new RegExp(`hive: not resuming ${worker.name}: the restored process id ${stranger.pid} is not the shell running this resume`));
    assert.equal(forged.output[3], "", "a forged pid gets no launch line");
    assert.equal(rowById(worker.id).pane_pid, worker.pane_pid, "nor is it recorded");
    assert.equal(rowById(worker.id).status, "closed");

    const child = startResume(worker.id, worker.tmux_target);
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
      killGroup(child);
      db.prepare("UPDATE agents SET status = 'closed' WHERE id = ?").run(worker.id);
    }
  });

  it("without the trust rule, restored blocks are shells: the worker row is reaped and the lead row reads reissued", async () => {
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
    assert.equal(rowById(lead.id).status, "running", "the janitor never sweeps a lead");
    assert.equal(terminal.rowOwnership(rowById(lead.id)), "reissued", "so hive lead restarts it");
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

  it("a fake rex call that asks for no process runs no ps for restored blocks, so its state lock is not held per block", () => {
    rexApi(process.env.REX_SERVER, "session.create", {
      label: "s-ps-count",
      initial_windows: [{ window_label: "ps", layout: { block: { flavor: "com.superlogical.terminal.shell", label: "ps", options: { shell: "none", login: false, command: ["sleep", "600"] } } } }],
    });
    fakeRexDo(dirs.tmp, "restartServer", { trust: false, env: { PATH: CLAUDE_PATH } });
    const live = Object.values(fake.state().blocks).filter((b) => b.restored && !existsSync(join(b.dir, "exit.json")));
    assert.ok(live.length > 0, "the restart left live restored blocks");
    const shimDir = mkdtempSync(join(dirs.tmp, "ps-shim-"));
    const count = join(shimDir, "count");
    const realPs = spawnSync("/bin/sh", ["-c", "command -v ps"], { encoding: "utf8", env: rexEnv }).stdout.trim();
    writeFileSync(join(shimDir, "ps"), `#!/bin/sh\necho x >> ${JSON.stringify(count)}\nexec ${JSON.stringify(realPs)} "$@"\n`);
    chmodSync(join(shimDir, "ps"), 0o755);
    const run = spawnSync("rex", ["--autostart=false", "--timeout", "5s", "api", "call", "session.list", "{}"], { encoding: "utf8", env: { ...fake.env, PATH: `${shimDir}:${fake.env.PATH}` } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(count) ? readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0, 0);
  });

  it("hive setup --rex-resume prints the rule and writes nothing to Rex's config", async () => {
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
