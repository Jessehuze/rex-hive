import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { parse } from "yaml";

import {
  DIST,
  isolateTmux,
  leadRow,
  makeFakeClaude,
  McpClient,
  runCli,
  runNode,
  scratchDirs,
  withEnv,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("rex terminal setting tests");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
delete process.env.HIVE_TERMINAL;

const clients = [];
let sessionToClean = null;

after(async () => {
  for (const client of clients) await client.close();
  cleanup(sessionToClean ?? undefined);
});

async function dist() {
  const { db, migrate } = await import("../dist/db.js");
  migrate();
  const terminal = await import("../dist/terminal.js");
  const { loadProjectYml } = await import("../dist/projectYml.js");
  return { db, loadProjectYml, ...terminal };
}

function freshProject(name, yml) {
  const dir = mkdtempSync(join(dirname(dirs.projectDir), `${name}-`));
  if (yml !== undefined) writeFileSync(join(dir, "hive.yml"), yml);
  return dir;
}

const writeGlobal = (text) => {
  mkdirSync(dirs.dataDir, { recursive: true });
  writeFileSync(join(dirs.dataDir, "hive.yml"), text);
};

function recordingRex() {
  const bin = mkdtempSync(join(dirs.tmp, "rex-bin-"));
  const log = join(bin, "rex-calls.log");
  writeFileSync(join(bin, "rex"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 1\n`);
  chmodSync(join(bin, "rex"), 0o755);
  try {
    execFileSync(join(bin, "rex"), ["probe", "--self-check"], { stdio: "ignore" });
  } catch {
  }
  assert.equal(readFileSync(log, "utf8"), "probe --self-check\n", "the recording rex stub must record a direct call");
  writeFileSync(log, "");
  return { bin, calls: () => readFileSync(log, "utf8") };
}

const REX_ENV = { REX_BLOCK: "block:fake", REX_SERVER: "unix:///nonexistent" };

describe("terminal setting", () => {
  it("HIVE_TERMINAL beats hive.yml beats global config beats tmux", async () => {
    const { loadProjectYml, resolveTerminal } = await dist();
    const withProjectTmux = freshProject("env-wins", "terminal: tmux\n");
    const withProjectRex = freshProject("project-wins", "terminal: rex\n");
    const withoutKey = freshProject("global-wins", "placement: split\n");
    const project = (dir) => loadProjectYml(dir).config;

    writeGlobal("terminal: rex\n");
    try {
      assert.deepEqual(
        withEnv({ HIVE_TERMINAL: "tmux" }, () => resolveTerminal(project(withProjectRex))),
        { terminal: "tmux", source: "env" },
      );
      assert.deepEqual(resolveTerminal(project(withProjectTmux)), { terminal: "tmux", source: "project" });
      assert.equal(project(withoutKey).terminal, null, "the global key must not masquerade as a project value");
      assert.deepEqual(resolveTerminal(project(withoutKey)), { terminal: "rex", source: "global" });
    } finally {
      writeGlobal("");
    }
    assert.deepEqual(resolveTerminal(project(withoutKey)), { terminal: "tmux", source: "default" });
  });

  it("unknown terminal value warns and resolves tmux", async () => {
    const { loadProjectYml, resolveTerminal } = await dist();
    const dir = freshProject("unknown-terminal", "terminal: screen\n");
    const { config, warnings } = loadProjectYml(dir);
    assert.ok(
      warnings.some((w) => w.includes('terminal must be "tmux" or "rex"') && w.includes('ignoring "screen"')),
      JSON.stringify(warnings),
    );
    assert.equal(config.terminal, null);
    assert.deepEqual(resolveTerminal(config), { terminal: "tmux", source: "default" });
  });

  it("an unknown HIVE_TERMINAL warns naming HIVE_TERMINAL and falls through to hive.yml", async () => {
    const { loadProjectYml, resolveTerminal } = await dist();
    const config = loadProjectYml(freshProject("env-unknown", "terminal: rex\n")).config;
    for (const value of ["TMUX", "screen"]) {
      const warnings = [];
      const resolved = withEnv({ HIVE_TERMINAL: value }, () => resolveTerminal(config, warnings));
      assert.deepEqual(resolved, { terminal: "rex", source: "project" });
      assert.deepEqual(warnings, [`HIVE_TERMINAL: terminal must be "tmux" or "rex"; ignoring "${value}".`]);
    }
    const quiet = [];
    withEnv({ HIVE_TERMINAL: "tmux" }, () => resolveTerminal(config, quiet));
    assert.deepEqual(quiet, []);
  });

  it("doctor's config terminal row shows the resolved terminal and its source, and is absent when nothing chose one", { skip: hasTmux ? false : "tmux is not installed" }, async () => {
    const doctor = async ({ global, env = {} }) => {
      const own = scratchDirs();
      const opts = { cwd: own.projectDir, dataDir: own.dataDir, tmp: own.tmp };
      assert.equal((await runCli(["init", "--no-profile"], opts)).code, 0);
      if (global !== undefined) writeFileSync(join(own.dataDir, "hive.yml"), global);
      return (await runCli(["doctor"], { ...opts, env: { HIVE_NO_UPDATE_CHECK: "1", ...env } })).stdout;
    };
    assert.match(await doctor({ global: "terminal: rex\n" }), /info {2}config terminal: "rex" \(source: global\)/);
    assert.match(await doctor({ env: { HIVE_TERMINAL: "rex" } }), /info {2}config terminal: "rex" \(source: env\)/);
    assert.doesNotMatch(await doctor({}), /config terminal/);
    assert.match(
      await doctor({ env: { HIVE_TERMINAL: "TMUX" } }),
      /warn {2}config terminal: HIVE_TERMINAL: terminal must be "tmux" or "rex"; ignoring "TMUX"\./,
    );
  });

  it("workers and wait_for_port parse their valid values and warn on anything else in placement style", async () => {
    const { loadProjectYml } = await dist();
    const good = freshProject(
      "workers-good",
      "workers: hidden\nprocesses:\n  web:\n    command: npm start\n    wait_for_port: 3000\n" +
        "  api:\n    command: npm run api\n    wait_for_port: true\n  plain: make run\n" +
        "  top:\n    command: npm run top\n    wait_for_port: 65535\n",
    );
    const parsed = loadProjectYml(good);
    assert.deepEqual(parsed.warnings, []);
    assert.equal(parsed.config.workers, "hidden");
    assert.equal(parsed.config.processes.web.wait_for_port, 3000);
    assert.equal(parsed.config.processes.api.wait_for_port, true);
    assert.equal(parsed.config.processes.top.wait_for_port, 65535);
    assert.equal(parsed.config.processes.plain.wait_for_port ?? null, null);

    const bad = freshProject(
      "workers-bad",
      "workers: invisible\nprocesses:\n  web:\n    command: npm start\n    wait_for_port: 0\n" +
        "  api:\n    command: npm run api\n    wait_for_port: false\n" +
        "  big:\n    command: npm run big\n    wait_for_port: 65536\n",
    );
    const rejected = loadProjectYml(bad);
    assert.equal(rejected.config.workers, null);
    assert.equal(rejected.config.processes.web.wait_for_port ?? null, null);
    assert.equal(rejected.config.processes.api.wait_for_port ?? null, null);
    assert.equal(rejected.config.processes.big.wait_for_port ?? null, null);
    const text = rejected.warnings.join("\n");
    assert.match(text, /workers must be "shown" or "hidden"; ignoring "invisible"\./);
    const portWarning = (name, value) =>
      `Process "${name}": wait_for_port must be a port from 1 through 65535, or true; ignoring "${value}".`;
    assert.ok(text.includes(portWarning("web", "0")), text);
    assert.ok(text.includes(portWarning("api", "false")), text);
    assert.ok(text.includes(portWarning("big", "65536")), text);
  });

  it("terminalOfRow reads rex from a block: target or a rex: socket and tmux from anything else", async () => {
    const { terminalOfRow } = await dist();
    assert.equal(terminalOfRow({ tmux_target: "%12", tmux_socket: "/tmp/tmux-501/default" }), "tmux");
    assert.equal(terminalOfRow({ tmux_target: "%12", tmux_socket: "" }), "tmux");
    assert.equal(terminalOfRow({ tmux_target: "block:0b9e", tmux_socket: "rex:unix:///r.sock" }), "rex");
    assert.equal(terminalOfRow({ tmux_target: "block:0b9e", tmux_socket: "" }), "rex");
    assert.equal(terminalOfRow({ tmux_target: "", tmux_socket: "rex:unix:///r.sock" }), "rex");
  });

  it("hive setup --terminal rex writes the global key", async () => {
    const own = scratchDirs();
    const opts = { cwd: own.projectDir, dataDir: own.dataDir, tmp: own.tmp };
    const result = await runCli(["setup", "--dir", join(own.tmp, "bin"), "--terminal", "rex", "--force"], opts);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(parse(readFileSync(join(own.dataDir, "hive.yml"), "utf8")).terminal, "rex");
    assert.match(result.stdout, /terminal {5}rex \(source: global\)/);

    const bogus = await runCli(["setup", "--dir", join(own.tmp, "bin"), "--terminal", "screen", "--force"], opts);
    assert.equal(bogus.code, 1);
    assert.match(bogus.stdout, /--terminal must be one of: tmux, rex \(got screen\)/);
    assert.equal(parse(readFileSync(join(own.dataDir, "hive.yml"), "utf8")).terminal, "rex");
  });

  it("hive lead <registered path> from a pinned session with a closed row reaches the trust check, not a cached pin failure", async () => {
    const { db } = await dist();
    const dir = freshProject("closed-pin-target");
    const opts = { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    assert.equal((await runCli(["init", "--no-profile"], opts)).code, 0);
    writeFileSync(join(dir, "hive.yml"), "lead: closed-pin-untrusted-lead\n");
    const project = db.prepare("SELECT id FROM projects WHERE path = ?").get(dir);
    const actorId = "agent:closed-pin-preview";
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
       VALUES (?, ?, 'closed-pin-worker', '', 'sleep', ?, 'agent', 'closed')`,
    ).run(project.id, actorId, dir);
    const elsewhere = freshProject("closed-pin-cwd");
    const result = await runCli(["lead", dir, "--detach"], {
      cwd: elsewhere,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { HIVE_AGENT_ID: actorId, HIVE_PROJECT_LOCK: "1", HIVE_PROJECT_PATH: join(dirs.tmp, "gone", "nowhere") },
    });
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stderr + result.stdout, /agents row is closed/);
    assert.ok(
      result.stderr.includes('hive lead: "lead" is not trusted; run hive lead <path> interactively once'),
      result.stdout + result.stderr,
    );
  });

  it("hive setup names an unknown HIVE_TERMINAL once, and prints no terminal line when nothing chose one", async () => {
    const own = scratchDirs();
    const result = await runCli(["setup", "--dir", join(own.tmp, "bin"), "--force"], {
      cwd: own.projectDir,
      dataDir: own.dataDir,
      tmp: own.tmp,
      env: { HIVE_TERMINAL: "TMUX" },
    });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const warning = '! HIVE_TERMINAL: terminal must be "tmux" or "rex"; ignoring "TMUX".';
    assert.equal(result.stderr.split(warning).length - 1, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /^terminal /m);
  });

  it("rexInUse reads the kv flag and the cwd project's terminal and never runs rex", async () => {
    const own = scratchDirs();
    const rex = recordingRex();
    const script = join(own.tmp, "rex-in-use.mjs");
    writeFileSync(
      script,
      `const { migrate, db } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        "migrate();\n" +
        `const { rexInUse } = await import(${JSON.stringify(join(DIST, "rexInUse.js"))});\n` +
        "if (process.argv[2]) db.prepare(\"INSERT INTO kv (project_id, key, value) VALUES (?, 'terminal:rex:in-use', '1')\").run(Number(process.argv[2]));\n" +
        "process.stdout.write(String(rexInUse()));\n",
    );
    const run = (args = [], env = {}) =>
      runNode(script, args, {
        cwd: own.projectDir,
        dataDir: own.dataDir,
        tmp: own.tmp,
        env: { ...REX_ENV, PATH: `${rex.bin}:${process.env.PATH}`, ...env },
      });

    const plain = await run();
    assert.equal(plain.stdout, "false", plain.stderr);
    assert.equal((await run([], { HIVE_TERMINAL: "rex" })).stdout, "true");

    writeFileSync(join(own.projectDir, "hive.yml"), "terminal: rex\n");
    assert.equal((await run()).stdout, "false", "an unregistered cwd has no project hive.yml to read");
    const registered = await runCli(["init", "--no-profile"], { cwd: own.projectDir, dataDir: own.dataDir, tmp: own.tmp });
    assert.equal(registered.code, 0, registered.stderr);
    writeFileSync(join(own.projectDir, "hive.yml"), "terminal: rex\n");
    assert.equal((await run()).stdout, "true");
    writeFileSync(join(own.projectDir, "hive.yml"), "terminal: tmux\n");
    assert.equal((await run()).stdout, "false");

    const { default: Database } = await import("better-sqlite3");
    const store = new Database(join(own.dataDir, "hive.db"), { readonly: true });
    const projectId = store.prepare("SELECT id FROM projects LIMIT 1").get().id;
    store.close();
    assert.equal((await run([String(projectId)])).stdout, "true");
    assert.equal(rex.calls(), "", "rexInUse must never invoke rex");
  });
});

describe("terminal setting against a live tmux lead", () => {
  it("tmux terminal inside Rex makes no rex calls", { skip: hasTmux ? false : "tmux is not installed" }, async () => {
    const { db, terminalOfRow } = await dist();
    const { sessionName } = await import("../dist/tmux.js");
    sessionToClean = sessionName();
    const rex = recordingRex();
    const claude = makeFakeClaude(dirs.tmp)("sleep 600");
    const dir = freshProject("rex-quiet", "placement: split\n");
    const env = { ...REX_ENV, PATH: `${rex.bin}:${dirname(claude)}:${process.env.PATH}` };

    const led = await runCli(["lead", dir, "--detach"], { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp, env });
    assert.equal(led.code, 0, led.stdout + led.stderr);
    const status = await runCli(["status"], { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp, env });
    assert.equal(status.code, 0, status.stdout + status.stderr);

    assert.equal(rex.calls(), "");
    const project = db.prepare("SELECT id FROM projects WHERE path = ?").get(dir);
    const lead = leadRow(db, project.id);
    assert.match(lead.tmux_target, /^%\d+$/);
    assert.equal(terminalOfRow(lead), "tmux");
  });

  it("hive queen prints an unknown HIVE_TERMINAL warning once and starts on tmux", { skip: hasTmux ? false : "tmux is not installed" }, async () => {
    const { db } = await dist();
    const { sessionName } = await import("../dist/tmux.js");
    sessionToClean = sessionName();
    const claude = makeFakeClaude(dirs.tmp)("sleep 600");
    const result = await runCli(["queen", "--no-dashboard"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { HIVE_TERMINAL: "TMUX", PATH: `${dirname(claude)}:${process.env.PATH}` },
    });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const warning = '! HIVE_TERMINAL: terminal must be "tmux" or "rex"; ignoring "TMUX".';
    assert.equal((result.stdout + result.stderr).split(warning).length - 1, 1, result.stdout + result.stderr);
    const queen = db.prepare("SELECT id FROM projects WHERE name = 'queen'").get();
    assert.match(leadRow(db, queen.id).tmux_target, /^%\d+$/);
  });

  it("a worker spawned under a tmux lead stays tmux after hive.yml switches to rex", { skip: hasTmux ? false : "tmux is not installed" }, async () => {
    const { db, loadProjectYml, resolveTerminal, terminalOfRow } = await dist();
    const { sessionName } = await import("../dist/tmux.js");
    sessionToClean = sessionName();
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const claude = fakeClaude("sleep 600");
    const dir = freshProject("rex-switch", "placement: split\n");
    const led = await runCli(["lead", dir, "--detach"], {
      cwd: dir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { PATH: `${dirname(claude)}:${process.env.PATH}` },
    });
    assert.equal(led.code, 0, led.stdout + led.stderr);
    const project = db.prepare("SELECT id FROM projects WHERE path = ?").get(dir);
    const lead = leadRow(db, project.id);
    assert.equal(terminalOfRow(lead), "tmux");

    writeFileSync(join(dir, "hive.yml"), "placement: split\nterminal: rex\n");
    assert.deepEqual(resolveTerminal(loadProjectYml(dir).config), { terminal: "rex", source: "project" });

    const mcp = new McpClient({
      cwd: dir,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: lead.actor_id, HIVE_SPAWN_READY_MS: "500", HIVE_TERMINAL: "rex" },
    });
    clients.push(mcp);
    await mcp.start();
    const spawned = await mcp.call("agent_spawn", {
      name: "stays-tmux",
      command: fakeClaude("sleep 600"),
      extra_args: [],
      placement: "window",
    });
    assert.equal(spawned.name, "stays-tmux", JSON.stringify(spawned));
    const worker = db.prepare("SELECT tmux_target, tmux_socket, status FROM agents WHERE project_id = ? AND name = ?")
      .get(project.id, "stays-tmux");
    assert.equal(worker.status, "running");
    assert.match(worker.tmux_target, /^%\d+$/);
    assert.doesNotMatch(worker.tmux_socket, /^rex:/);
    assert.equal(terminalOfRow(worker), terminalOfRow(lead));
  });
});
