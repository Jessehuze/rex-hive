import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, leadRow, makeFakeClaude, McpClient, runCli, scratchDirs } from "./helpers.mjs";
import { fakeRexDo, isolateRex, waitFor } from "./rex-helpers.mjs";

const { hasTmux, cleanup: cleanupTmux } = isolateTmux("rex spawn tests");
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
const terminal = await import("../dist/terminal.js");
const { rexApi } = await import("../dist/rexCli.js");
const { sessionName } = await import("../dist/tmux.js");
const { REX_IN_USE_KEY, commandArgv, rexWindowKey } = await import("../dist/terminal/rex.js");
const { REX_WORKER_BRIEF_LINE, workerBrief, workerCommandString } = await import("../dist/brief.js");

const clients = [];
let tmuxSession = null;
after(async () => {
  for (const client of clients) await client.close();
  fake.cleanup();
  cleanupTmux(tmuxSession ?? undefined);
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

function freshProject(name, yml) {
  const dir = mkdtempSync(join(dirname(dirs.projectDir), `${name}-`));
  if (yml !== undefined) writeFileSync(join(dir, "hive.yml"), yml);
  return dir;
}

const projectOf = (dir) => db.prepare("SELECT id, name, path FROM projects WHERE path = ?").get(dir);

async function startLead(dir, env = {}) {
  const result = await runCli(["lead", dir, "--detach"], {
    cwd: dir,
    dataDir: dirs.dataDir,
    tmp: dirs.tmp,
    env: withClaude({ HIVE_TERMINAL: "rex", ...env }),
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return { result, project: projectOf(dir) };
}

async function leadMcp(dir, project, readyMs = "300") {
  const lead = leadRow(db, project.id);
  const mcp = new McpClient({
    cwd: dir,
    dataDir: dirs.dataDir,
    env: withClaude({ HIVE_AGENT_ID: lead.actor_id, HIVE_SPAWN_READY_MS: readyMs }),
  });
  clients.push(mcp);
  await mcp.start();
  return { mcp, lead };
}

async function trustedLeadProject(name, lead) {
  const dir = freshProject(name);
  assert.equal((await runCli(["init", "--no-profile"], { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp, env: rexEnv })).code, 0);
  writeFileSync(join(dir, "hive.yml"), `lead: ${lead}\n`);
  const { configHash } = await import("../dist/projectYml.js");
  const project = projectOf(dir);
  db.prepare("INSERT OR IGNORE INTO command_trust (project_id, name, config_hash) VALUES (?, 'lead', ?)").run(project.id, configHash("lead", lead, null, {}));
  return { dir, project };
}

const workerRow = (projectId, name) =>
  db.prepare("SELECT * FROM agents WHERE project_id = ? AND name = ? ORDER BY id DESC LIMIT 1").get(projectId, name);

describe("Rex leads", () => {
  it("hive lead under Rex creates one labelled tab per project and records block:/rex: on the lead row", async () => {
    const one = freshProject("rex-tab-one");
    const two = freshProject("rex-tab-two");
    const a = await startLead(one);
    const b = await startLead(two);
    const state = fake.state();
    const home = state.sessions.filter((s) => s.label === sessionName());
    assert.equal(home.length, 1, JSON.stringify(state.sessions));
    for (const { project } of [a, b]) {
      const lead = leadRow(db, project.id);
      assert.match(lead.tmux_target, /^block:/);
      assert.equal(lead.tmux_socket, SOCKET);
      const block = state.blocks[lead.tmux_target];
      assert.equal(block.label, `${project.name}/lead`);
      assert.equal(lead.pane_pid, String(block.child_pid));
      const tabs = state.windows.filter((w) => w.label === project.name);
      assert.equal(tabs.length, 1, `one tab for ${project.name}`);
      assert.equal(tabs[0].session_id, home[0].session_id);
      assert.equal(block.window_id, tabs[0].window_id);
      assert.deepEqual(block.options.exit, { on_completion: true, quick_exit_threshold_ms: 1000 });
      assert.equal(block.options.shell, "none");
      assert.equal(block.options.cwd, project.path);
      const kv = db.prepare("SELECT value FROM kv WHERE project_id = ? AND key = ?").get(project.id, rexWindowKey(project.id));
      assert.equal(kv?.value, tabs[0].window_id);
    }
    assert.equal(apiCalls().filter((c) => c.method === "session.create").length, 1);
  });

  it("after the first Rex pane, hive status snapshots Rex even with no Rex setting", async () => {
    const dir = freshProject("rex-in-use");
    const { project } = await startLead(dir);
    assert.ok(db.prepare("SELECT 1 FROM kv WHERE project_id = ? AND key = ?").get(project.id, REX_IN_USE_KEY));
    const plain = freshProject("rex-in-use-plain");
    assert.equal((await runCli(["init", "--no-profile"], { cwd: plain, dataDir: dirs.dataDir, tmp: dirs.tmp, env: rexEnv })).code, 0);
    const before = realCalls().length;
    const status = await runCli(["status"], { cwd: plain, dataDir: dirs.dataDir, tmp: dirs.tmp, env: rexEnv });
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.ok(realCalls().slice(before).some((c) => c.argv.includes("do")), "the janitor must take a Rex snapshot");
    assert.equal(leadRow(db, project.id).status, "running");
  });

  it("second hive lead for the same project adopts the live lead block", async () => {
    const dir = freshProject("rex-adopt");
    const { project } = await startLead(dir);
    const first = leadRow(db, project.id);
    const blocks = Object.keys(fake.state().blocks).length;
    const before = realCalls().length;
    await startLead(dir);
    const second = leadRow(db, project.id);
    assert.equal(second.tmux_target, first.tmux_target);
    assert.equal(second.pane_pid, first.pane_pid);
    assert.equal(Object.keys(fake.state().blocks).length, blocks);
    assert.deepEqual(apiCalls(before).filter((c) => /new_window|new_split|session\.create/.test(c.method)), []);
  });

  it("a live Rex lead is adopted even when HIVE_TERMINAL=tmux", async () => {
    const dir = freshProject("rex-adopt-tmux-env");
    const { project } = await startLead(dir);
    const first = leadRow(db, project.id);
    await startLead(dir, { HIVE_TERMINAL: "tmux" });
    const second = leadRow(db, project.id);
    assert.equal(second.tmux_target, first.tmux_target);
    assert.equal(second.tmux_socket, SOCKET);
  });

  it("hive lead inside Rex uses the caller's session and never renames it", async () => {
    const made = rexApi(REX_ADDR, "session.create", {
      label: "user-session",
      initial_windows: [{ window_label: "mine", layout: { block: { flavor: "com.superlogical.terminal.shell", label: "me", options: { shell: "none", login: false, command: ["sleep", "600"] } } } }],
    });
    const caller = made.initial_windows[0].block_ids[0];
    const dir = freshProject("rex-caller");
    const before = realCalls().length;
    const { project } = await startLead(dir, { REX_BLOCK: caller });
    const state = fake.state();
    const lead = state.blocks[leadRow(db, project.id).tmux_target];
    assert.equal(lead.session_id, made.session_id);
    assert.equal(state.windows.find((w) => w.window_id === lead.window_id).label, project.name);
    assert.equal(state.sessions.find((s) => s.session_id === made.session_id).label, "user-session");
    const calls = apiCalls(before);
    assert.deepEqual(calls.filter((c) => /set_label|set_window_label|session\.create/.test(c.method)), []);
    assert.equal(state.windows.find((w) => w.window_id === made.initial_windows[0].window_id).label, "mine");
  });

  it("hive lead names an unknown HIVE_TERMINAL once and starts the hive.yml rex lead", async () => {
    const dir = freshProject("rex-env-unknown", "terminal: rex\n");
    const { result, project } = await startLead(dir, { HIVE_TERMINAL: "TMUX" });
    const warning = '! HIVE_TERMINAL: terminal must be "tmux" or "rex"; ignoring "TMUX".';
    assert.equal((result.stdout + result.stderr).split(warning).length - 1, 1, result.stderr);
    assert.match(leadRow(db, project.id).tmux_target, /^block:/);
  });

  it("hive queen under HIVE_TERMINAL=rex starts its lead in a queen tab", async () => {
    const own = scratchDirs();
    const result = await runCli(["queen", "--no-dashboard"], {
      cwd: own.projectDir,
      dataDir: own.dataDir,
      tmp: own.tmp,
      env: withClaude({ HIVE_TERMINAL: "rex", HIVE_AUTO_OPEN: "0" }),
    });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const { default: Database } = await import("better-sqlite3");
    const store = new Database(join(own.dataDir, "hive.db"), { readonly: true });
    const lead = store.prepare("SELECT a.tmux_target, a.tmux_socket FROM agents a JOIN projects p ON p.id = a.project_id WHERE p.name = 'queen' AND a.kind = 'lead'").get();
    store.close();
    assert.match(lead.tmux_target, /^block:/);
    assert.equal(lead.tmux_socket, SOCKET);
    const block = fake.state().blocks[lead.tmux_target];
    assert.equal(fake.state().windows.find((w) => w.window_id === block.window_id).label, "queen");
  });
});

describe("Rex workers", () => {
  it("agent_spawn under a Rex lead splits beside the lead and resizes nothing else", async () => {
    const dir = freshProject("rex-split");
    const { project } = await startLead(dir);
    const { mcp, lead } = await leadMcp(dir, project);
    const session = fake.state().blocks[lead.tmux_target].session_id;
    rexApi(REX_ADDR, "block.method", { session_id: session, block_id: lead.tmux_target, method: "resize", args: { columns: 132, rows: 40 } });
    const before = realCalls().length;
    const spawned = await mcp.call("agent_spawn", { name: "w-split", command: fakeClaude("sleep 600"), placement: "split" });
    const calls = apiCalls(before);
    const splits = calls.filter((c) => c.method === "session.new_split");
    assert.equal(splits.length, 1, JSON.stringify(calls.map((c) => c.method)));
    assert.equal(splits[0].params.anchor_id, lead.tmux_target);
    assert.deepEqual(splits[0].params.layout.block.options.size, { columns: 132, rows: 40 });
    assert.equal(calls.filter((c) => c.method === "session.resize_pane").length, 0);
    assert.equal(calls.filter((c) => c.method === "session.new_window").length, 0);
    const row = workerRow(project.id, "w-split");
    assert.equal(row.tmux_target, spawned.tmux_target);
    assert.equal(row.tmux_socket, SOCKET);
    const state = fake.state();
    assert.equal(state.blocks[row.tmux_target].window_id, state.blocks[lead.tmux_target].window_id);
    assert.equal(state.blocks[row.tmux_target].label, `${project.name}/w-split`);
    assert.equal(state.blocks[row.tmux_target].options.exit.on_completion, false, "a claude worker's block is retained so its final screen stays readable");
  });

  it("placement window opens a tab in the lead's session", async () => {
    const dir = freshProject("rex-window");
    const { project } = await startLead(dir);
    const { mcp, lead } = await leadMcp(dir, project);
    const before = realCalls().length;
    await mcp.call("agent_spawn", { name: "w-tab", command: fakeClaude("sleep 600"), placement: "window" });
    const tabs = apiCalls(before).filter((c) => c.method === "session.new_window");
    assert.equal(tabs.length, 1);
    const state = fake.state();
    const block = state.blocks[workerRow(project.id, "w-tab").tmux_target];
    assert.equal(tabs[0].params.session_id, state.blocks[lead.tmux_target].session_id);
    assert.equal(block.session_id, state.blocks[lead.tmux_target].session_id);
    assert.notEqual(block.window_id, state.blocks[lead.tmux_target].window_id);
    assert.equal(state.windows.find((w) => w.window_id === block.window_id).label, `${project.name}/w-tab`);
  });

  it("worker env reaches the program through the env prefix", async () => {
    const dir = freshProject("rex-env");
    const { project } = await startLead(dir);
    const { mcp } = await leadMcp(dir, project);
    const dump = join(dirs.tmp, "worker-env.txt");
    await mcp.call("agent_spawn", { name: "w-env", command: fakeClaude(`env > ${dump}; sleep 600`) });
    await waitFor(() => readFileSync(dump, { flag: "a+" }).toString().includes("HIVE_PROJECT_LOCK"));
    const row = workerRow(project.id, "w-env");
    const env = readFileSync(dump, "utf8").split("\n");
    assert.ok(env.includes(`HIVE_AGENT_ID=${row.actor_id}`), env.join("\n"));
    assert.ok(env.includes("HIVE_PROJECT_LOCK=1"));
    assert.ok(env.includes(`PATH=${withClaude().PATH}`), "the block's PATH is the one hive passes, not the minimal login:false PATH");
    const block = fake.state().blocks[row.tmux_target];
    assert.equal(block.command[0], "/usr/bin/env");
    assert.equal(basename(terminal.paneCurrentCommand(row.tmux_target) ?? ""), "claude", "a login-wrapped block reports no program");
    assert.equal(terminal.rowOwnership(row), "live", "argv0 after env execs is the recorded program");
  });

  it("a worker that dies within 250ms reports its screen and leaves no block", async () => {
    const dir = freshProject("rex-quick");
    const { project } = await startLead(dir);
    const { mcp } = await leadMcp(dir, project, "15000");
    const bin = join(dirs.tmp, "quick-bin");
    mkdirSync(bin, { recursive: true });
    const quick = join(bin, "quickdie");
    writeFileSync(quick, "#!/bin/sh\necho 'quickdie: unknown flag --bogus'\nexit 3\n");
    chmodSync(quick, 0o755);
    await assert.rejects(mcp.call("agent_spawn", { name: "w-quick", command: quick }), /quickdie: unknown flag --bogus/);
    const labels = Object.values(fake.state().blocks).map((b) => b.label);
    assert.ok(!labels.includes(`${project.name}/w-quick`), labels.join(","));
    assert.equal(workerRow(project.id, "w-quick"), undefined);

    const receipt = await mcp.call("agent_spawn", { name: "w-quick-claude", command: fakeClaude("echo 'claude: config is broken'; sleep 1.5; exit 3") });
    assert.equal(receipt.exited, true, JSON.stringify(receipt));
    assert.match(receipt.tail, /claude: config is broken/, "only a retained block still holds the screen after Rex's quick-exit threshold");
    assert.ok(!Object.values(fake.state().blocks).some((b) => b.label === `${project.name}/w-quick-claude`));
  });

  it("Rex worker brief forbids touching Rex blocks; tmux brief does not", async () => {
    const ctx = { name: "w", actorId: "agent:1", projectName: "p", projectPath: dirs.projectDir, cwd: dirs.projectDir };
    assert.ok(workerBrief({ ...ctx, rex: true }).includes(REX_WORKER_BRIEF_LINE));
    assert.ok(!workerBrief(ctx).includes(REX_WORKER_BRIEF_LINE));
    const dir = freshProject("rex-brief");
    const { project } = await startLead(dir);
    const { mcp } = await leadMcp(dir, project);
    const spawned = await mcp.call("agent_spawn", { name: "w-brief", command: fakeClaude("sleep 600") });
    assert.ok(readFileSync(spawned.brief_path, "utf8").includes(REX_WORKER_BRIEF_LINE));
  });

  it("the Rex argv is the worker command's own words, quoting undone", () => {
    const spec = { command: CLAUDE, displayName: "w x", extraArgs: ["--append", "it's \"quoted\" $HOME `x` a;b"], briefPath: "/tmp/b r.md" };
    const argv = commandArgv(workerCommandString(spec));
    assert.equal(argv[0], CLAUDE);
    assert.ok(argv.includes("it's \"quoted\" $HOME `x` a;b"), JSON.stringify(argv));
    assert.ok(argv.includes("/tmp/b r.md"));
    assert.deepEqual(commandArgv("npm run dev && claude"), ["/bin/sh", "-c", "npm run dev && claude"]);
  });
});

describe("Rex ownership of what hive launched", () => {
  it("ownership reads the program behind /usr/bin/env, its PATH= word and env assignments", async () => {
    const dir = freshProject("rex-own-env");
    const { project } = await startLead(dir);
    const lead = leadRow(db, project.id);
    const session = fake.state().blocks[lead.tmux_target].session_id;
    const layout = { block: { flavor: "com.superlogical.terminal.shell", label: "raw", options: { shell: "none", login: false, command: ["/usr/bin/env", "PATH=/usr/bin:/bin", "FOO=1", "sleep", "600"] } } };
    const made = rexApi(REX_ADDR, "session.new_split", { session_id: session, anchor_id: lead.tmux_target, direction: "horizontal", side: "after", layout, focus: false });
    const block = made.block_ids[0];
    const pid = String(fake.state().blocks[block].child_pid);
    const row = (command) => ({ tmux_target: block, tmux_socket: SOCKET, pane_pid: pid, command });
    assert.equal(terminal.rowOwnership(row("sleep 600")), "live");
    assert.equal(terminal.rowOwnership(row("/usr/bin/env PATH=/x FOO=1 sleep 600")), "live");
    assert.equal(terminal.rowOwnership(row("claude")), "reissued");
  });

  it("a hive.yml lead with shell syntax runs through sh and a second hive lead adopts it", async () => {
    const lead = "sleep 600 && true";
    const { dir, project } = await trustedLeadProject("rex-sh-lead", lead);
    await startLead(dir);
    const first = leadRow(db, project.id);
    assert.deepEqual(fake.state().blocks[first.tmux_target].command.slice(-3), ["/bin/sh", "-c", lead]);
    assert.equal(terminal.rowOwnership(first), "live");
    await startLead(dir);
    assert.equal(leadRow(db, project.id).tmux_target, first.tmux_target);
  });
});

describe("Rex leads under contention, failure and moves", () => {
  it("a hive.yml lead with an env assignment, which sh execs, is adopted by a second hive lead", async () => {
    const lead = "FOO=1 sleep 600";
    const { dir, project } = await trustedLeadProject("rex-assign-lead", lead);
    await startLead(dir);
    const first = leadRow(db, project.id);
    assert.deepEqual(fake.state().blocks[first.tmux_target].command.slice(-3), ["/bin/sh", "-c", lead]);
    assert.equal(basename(terminal.paneCurrentCommand(first.tmux_target) ?? ""), "sleep", "sh execs a single simple command");
    await startLead(dir);
    assert.equal(leadRow(db, project.id).tmux_target, first.tmux_target);
  });

  it("two concurrent hive leads in a fresh store create one home session and one tab each", async () => {
    const own = scratchDirs();
    const one = mkdtempSync(join(own.tmp, "race-one-"));
    const two = mkdtempSync(join(own.tmp, "race-two-"));
    const before = realCalls().length;
    const run = (dir) =>
      runCli(["lead", dir, "--detach"], { cwd: dir, dataDir: own.dataDir, tmp: own.tmp, env: withClaude({ HIVE_TERMINAL: "rex" }) });
    const results = await Promise.all([run(one), run(two)]);
    for (const r of results) assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(apiCalls(before).filter((c) => c.method === "session.create").length, 1);
    const tabs = apiCalls(before).filter((c) => c.method === "session.new_window");
    assert.equal(tabs.length, 2);
    assert.equal(new Set(tabs.map((c) => c.params.session_id)).size, 1);
  });

  it("a codex lead that exits at once reports its screen, leaves no block and reaps its CODEX_HOME", async () => {
    const bin = join(dirs.tmp, "codex-quick-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "codex"), "#!/bin/sh\necho 'codex: auth is broken'\nexit 3\n");
    chmodSync(join(bin, "codex"), 0o755);
    const home = mkdtempSync(join(dirs.tmp, "codex-home-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "{}\n");
    const { dir, project } = await trustedLeadProject("rex-codex-quick", "codex");
    const homes = join(dirs.dataDir, "codex-homes");
    const homesBefore = existsSync(homes) ? readdirSync(homes).length : 0;
    const result = await runCli(["lead", dir, "--detach"], {
      cwd: dir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: withClaude({ HIVE_TERMINAL: "rex", HOME: home, PATH: `${bin}:${withClaude().PATH}` }),
    });
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stdout + result.stderr, /codex: auth is broken/, result.stdout);
    assert.ok(!Object.values(fake.state().blocks).some((b) => b.label === `${project.name}/lead`));
    assert.equal(existsSync(homes) ? readdirSync(homes).length : 0, homesBefore, "the fresh CODEX_HOME must be reaped");
  });

  it("a recorded tab moved to an unrelated session is still the project's home", async () => {
    const dir = freshProject("rex-moved-tab");
    const { project } = await startLead(dir);
    const lead = leadRow(db, project.id);
    const state = fake.state();
    const window = state.blocks[lead.tmux_target].window_id;
    const layout = { block: { flavor: "com.superlogical.terminal.shell", label: "keeper", options: { shell: "none", login: false, command: ["sleep", "600"] } } };
    rexApi(REX_ADDR, "session.new_split", { session_id: state.blocks[lead.tmux_target].session_id, anchor_id: lead.tmux_target, direction: "horizontal", side: "after", layout, focus: false });
    fakeRexDo(dirs.tmp, "closeBlock", { block_id: lead.tmux_target });
    const moved = fakeRexDo(dirs.tmp, "transferWindow", { window_id: window, session_label: "somewhere-else" });
    const before = realCalls().length;
    await startLead(dir);
    const relead = fake.state().blocks[leadRow(db, project.id).tmux_target];
    assert.equal(relead.window_id, window);
    assert.equal(relead.session_id, moved.session_id);
    assert.deepEqual(apiCalls(before).filter((c) => c.method === "session.new_window"), []);
  });
});

describe("terminal follows the live lead row", () => {
  it("a live tmux lead is still adopted after hive.yml switches to rex", { skip: hasTmux ? false : "tmux is not installed" }, async () => {
    tmuxSession = sessionName();
    const dir = freshProject("tmux-then-rex", "placement: split\n");
    const opts = { cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp, env: withClaude() };
    const first = await runCli(["lead", dir, "--detach"], opts);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    const project = projectOf(dir);
    const before = leadRow(db, project.id);
    assert.match(before.tmux_target, /^%\d+$/);
    writeFileSync(join(dir, "hive.yml"), "placement: split\nterminal: rex\n");
    const calls = realCalls().length;
    const again = await runCli(["lead", dir, "--detach"], opts);
    assert.equal(again.code, 0, again.stdout + again.stderr);
    const after = leadRow(db, project.id);
    assert.equal(after.tmux_target, before.tmux_target);
    assert.equal(after.tmux_socket, before.tmux_socket);
    assert.deepEqual(apiCalls(calls).filter((c) => /new_window|new_split|session\.create/.test(c.method)), []);
  });
});
