import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, makeFakeClaude, runCli, scratchDirs, seedTrustedYml } from "./helpers.mjs";
import { fakeRexDo, isolateRex, waitFor } from "./rex-helpers.mjs";

const { hasTmux, cleanup: cleanupTmux } = isolateTmux("rex ports tests");
const dirs = scratchDirs();
const fake = isolateRex(dirs.tmp);
clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const rexEnv = Object.fromEntries(Object.entries(fake.env).filter(([k]) => !k.startsWith("HIVE_")));

const { db, migrate } = await import("../dist/db.js");
migrate();
await import("../dist/rexInUse.js");
const { rexPorts } = await import("../dist/terminal/rex.js");
const { snapshotProcesses } = await import("../dist/processes.js");
const { renderDashboard } = await import("../dist/dashboard.js");

const tmuxSessions = [];
after(() => {
  fake.cleanup();
  cleanupTmux(...tmuxSessions);
});

const fakeClaude = makeFakeClaude(dirs.tmp);
const CLAUDE = fakeClaude("sleep 600");
const withClaude = (env = {}) => ({ ...rexEnv, PATH: `${dirname(CLAUDE)}:${rexEnv.PATH}`, ...env });

const realCalls = () => fake.calls().filter((c) => c.argv[0] !== "__fake");
const blockMethodsSince = (since) =>
  realCalls()
    .slice(since)
    .map((c) => {
      const i = c.argv.indexOf("call");
      return i >= 0 && c.argv[i + 1] === "block.method" ? JSON.parse(c.argv[i + 2]).method : null;
    })
    .filter(Boolean);
const portsCallsSince = (since) => blockMethodsSince(since).filter((m) => m === "ports").length;

const freshProject = (name) => mkdtempSync(join(dirname(dirs.projectDir), `${name}-`));
const projectOf = (dir) => db.prepare("SELECT id, name, path FROM projects WHERE path = ?").get(dir);
const cli = (args, dir, env = {}) => runCli(args, { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp, env: withClaude(env) });
const processRow = (projectId, name) =>
  db.prepare("SELECT * FROM agents WHERE project_id = ? AND name = ? AND kind = 'command' AND status = 'running'").get(projectId, name);

async function startLead(dir) {
  const result = await cli(["lead", dir, "--detach"], dir, { HIVE_TERMINAL: "rex" });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return projectOf(dir);
}

async function seedPortsYml(projectId, dir, processes) {
  await seedTrustedYml({ db, projectId, projectDir: dir, processes });
  const lines = Object.entries(processes).flatMap(([name, p]) => [
    `  ${name}:`,
    `    command: ${p.command}`,
    ...(p.visible === undefined ? [] : [`    visible: ${p.visible}`]),
    ...(p.wait_for_port === undefined ? [] : [`    wait_for_port: ${p.wait_for_port}`]),
  ]);
  writeFileSync(join(dir, "hive.yml"), `processes:\n${lines.join("\n")}\n`);
}

async function blockOf(projectId, name) {
  await waitFor(() => processRow(projectId, name)?.tmux_target?.startsWith("block:"), { timeoutMs: 15_000 });
  return processRow(projectId, name).tmux_target;
}

describe("Rex process ports", () => {
  it("hive start waits for wait_for_port and prints the ports", async () => {
    const dir = freshProject("rex-wait-port");
    const project = await startLead(dir);
    await seedPortsYml(project.id, dir, { web: { command: "sleep 600", wait_for_port: 3000 } });
    const before = realCalls().length;
    const started = cli(["start", "web"], dir, { HIVE_WAIT_FOR_PORT_TIMEOUT_MS: "20000" });
    const block = await blockOf(project.id, "web");
    fakeRexDo(dirs.tmp, "setPorts", {
      block_id: block,
      after_ms: 1200,
      ports: [{ port: 9229 }, { port: 3000 }, { port: 3000, address: "::1" }, { port: 5353, protocol: "udp" }],
    });
    const result = await started;
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^web: started \(ports 3000, 9229\)$/m);
    assert.ok(portsCallsSince(before) >= 2, `polled ${portsCallsSince(before)} time(s): a wait polls until the port appears`);
  });

  it("wait_for_port timeout reports and leaves the process running", async () => {
    const dir = freshProject("rex-port-timeout");
    const project = await startLead(dir);
    await seedPortsYml(project.id, dir, { web: { command: "sleep 600", wait_for_port: 3000 } });
    const started = cli(["start", "web"], dir, { HIVE_WAIT_FOR_PORT_TIMEOUT_MS: "1000" });
    const block = await blockOf(project.id, "web");
    fakeRexDo(dirs.tmp, "setPorts", { block_id: block, ports: [{ port: 8080 }] });
    const result = await started;
    assert.match(result.stdout, /^web: started; port 3000 not listening after 1s$/m, result.stdout + result.stderr);
    assert.equal(result.code, 0);
    const row = processRow(project.id, "web");
    assert.equal(row?.tmux_target, block, "the row stays running after the timeout");
    const state = fake.state().blocks[block];
    assert.ok(state, "the block is still open");
    process.kill(state.child_pid, 0);
  });

  it("wait_for_port true waits for any port", async () => {
    const dir = freshProject("rex-any-port");
    const project = await startLead(dir);
    await seedPortsYml(project.id, dir, { web: { command: "sleep 600", wait_for_port: true } });
    const before = realCalls().length;
    const started = cli(["start", "web"], dir, { HIVE_WAIT_FOR_PORT_TIMEOUT_MS: "20000" });
    const block = await blockOf(project.id, "web");
    fakeRexDo(dirs.tmp, "setPorts", { block_id: block, after_ms: 1200, ports: [{ port: 4173 }] });
    const result = await started;
    assert.match(result.stdout, /^web: started \(ports 4173\)$/m, result.stdout + result.stderr);
    assert.ok(portsCallsSince(before) >= 2, "true still waits for a port to appear");
  });

  it("dashboard shows a process's listening ports on Rex", async () => {
    const dir = freshProject("rex-dash-ports");
    const project = await startLead(dir);
    await seedPortsYml(project.id, dir, { web: { command: "sleep 600" }, idle: { command: "sleep 600" } });
    assert.equal((await cli(["start", "web"], dir)).code, 0);
    fakeRexDo(dirs.tmp, "setPorts", { block_id: processRow(project.id, "web").tmux_target, ports: [{ port: 9229 }, { port: 3000 }] });

    const before = realCalls().length;
    const procs = snapshotProcesses(project.id);
    assert.equal(portsCallsSince(before), 1, "one ports read per Rex process row");
    const html = renderDashboard(project.id, procs);
    assert.match(html, /<span class="mono">web<\/span> <span class="muted">ports 3000, 9229<\/span>/);
    assert.equal(procs.find((p) => p.name === "idle").ports, undefined, "a process that is not running reads no ports");

    const status = await cli(["status"], dir);
    assert.match(status.stdout, /cmd\s+web\s+shown \(ports 3000, 9229\)$/m, status.stdout);
  });

  it("rexPorts reads a truncated reply in full, keeps tcp only, and is null when Rex cannot list", async () => {
    const dir = freshProject("rex-ports-read");
    const project = await startLead(dir);
    await seedPortsYml(project.id, dir, { web: { command: "sleep 600" } });
    assert.equal((await cli(["start", "web"], dir)).code, 0);
    const block = processRow(project.id, "web").tmux_target;
    fakeRexDo(dirs.tmp, "setPorts", {
      block_id: block,
      keep: 1,
      status: "partial",
      ports: [{ port: 3000 }, { port: 4000, protocol: "udp" }, { port: 5000, address: "::" }],
    });
    const before = realCalls().length;
    assert.deepEqual(rexPorts(block), [{ port: 3000, address: "127.0.0.1" }, { port: 5000, address: "::" }]);
    assert.ok(blockMethodsSince(before).includes("blob_read"), "a truncated reply is read in full");
    fakeRexDo(dirs.tmp, "setPorts", { block_id: block, status: "unsupported" });
    assert.equal(rexPorts(block), null);
    const tmuxBefore = realCalls().length;
    assert.equal(rexPorts("%12"), null);
    assert.equal(realCalls().length, tmuxBefore, "a tmux target never reaches rex");
  });

  it("wait_for_port on tmux warns and does not wait", { skip: hasTmux ? false : "tmux is not installed" }, async () => {
    const dir = freshProject("tmux-port");
    const init = await runCli(["init"], { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp });
    assert.equal(init.code, 0, init.stderr);
    const project = projectOf(dir);
    await seedPortsYml(project.id, dir, { web: { command: "sleep 600", visible: false, wait_for_port: 3000 } });
    const { createWindow, ensureSession, sessionName } = await import("../dist/tmux.js");
    const session = sessionName();
    tmuxSessions.push(session);
    ensureSession(session, dir, { bare: true });
    createWindow(session, project.name, dir, [], "sleep 600", project.id, true, false);

    const before = realCalls().length;
    const startedAt = Date.now();
    const result = await runCli(["start", "web"], { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp, env: { HIVE_WAIT_FOR_PORT_TIMEOUT_MS: "20000" } });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.split("wait_for_port needs terminal: rex; ignoring").length - 1, 1, result.stdout);
    assert.match(result.stdout, /^web: started \(hidden\)$/m);
    assert.ok(Date.now() - startedAt < 10_000, "a tmux start does not wait for the port");
    assert.equal(realCalls().length, before, "a tmux start makes no rex call");
  });
});
