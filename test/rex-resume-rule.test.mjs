import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { CLI, clearHiveEnv, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";
import { fakeRexDo, isolateRex } from "./rex-helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("rex resume rule tests");
clearHiveEnv();
const dirs = scratchDirs();
const fake = isolateRex(dirs.tmp);
process.env.HIVE_DATA_DIR = dirs.dataDir;
const rexEnv = fake.childEnv;

const { REX_RESUME_SCRIPT } = await import("../dist/rexResume.js");
const { dispatcherScript } = await import("../dist/dispatcher.js");

after(() => {
  fake.cleanup();
  cleanupTmux();
});

const OPEN = "-- >>> hive resume rule (managed by hive setup --rex-resume --install)";
const CLOSE = "-- <<< hive resume rule";
const HOME = mkdtempSync(join(dirs.tmp, "home-"));
const fallbackCommand = ["/bin/sh", "-c", REX_RESUME_SCRIPT, "hive", process.execPath, CLI, "__rex-resume", { match: "id" }, "--data-dir", dirs.dataDir];

function scratchConfig(name, content) {
  const path = join(mkdtempSync(join(dirs.tmp, `cfg-${name}-`)), "rex", "init.lua");
  if (content !== undefined) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return path;
}

const envFor = (config, extra = {}) => ({ ...rexEnv, HOME, REX_CONFIG: config, ...extra });

const hive = (args, config, extra) => runCli(args, { cwd: HOME, dataDir: dirs.dataDir, tmp: dirs.tmp, env: envFor(config, extra) });

function configCheck(config) {
  const run = spawnSync("rex", ["--autostart=false", "--timeout", "5s", "config", "check", "--json"], { encoding: "utf8", env: { ...fake.env, REX_CONFIG: config } });
  return JSON.parse(run.stdout);
}

const hiveRule = (config) => configCheck(config).resume_rules.find((r) => r.name === "hive" && !r.built_in);
const reloads = () => fake.state().config_reloads ?? [];
const blocksIn = (text) => text.split(OPEN).length - 1;
const rexCalls = () => fake.calls().filter((c) => c.argv[0] !== "__fake").length;

function pinDispatcher(name, node = process.execPath) {
  const bin = join(dirs.tmp, `bin-${name}`);
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "hive"), dispatcherScript(node, CLI));
  chmodSync(join(bin, "hive"), 0o755);
  return bin;
}

const ruleLine = (out) => out.split("\n").find((l) => /^ {2}(?:ok {4}|warn {2})rex resume rule: /.test(l)) ?? null;

describe("hive setup --rex-resume --install and --uninstall", () => {
  it("--install appends one marked block that rex config check reads as hive's expected command, keeps the user's lines, and reloads Rex", async () => {
    const config = scratchConfig("install", "-- the user's own config\nrex.bind('ctrl+a', 'x')\n");
    const before = reloads().length;
    const result = await hive(["setup", "--rex-resume", "--install"], config);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const text = readFileSync(config, "utf8");
    assert.ok(text.startsWith("-- the user's own config\nrex.bind('ctrl+a', 'x')\n"), text);
    assert.equal(blocksIn(text), 1);
    assert.ok(text.trimEnd().endsWith(CLOSE), text);
    assert.deepEqual(hiveRule(config).rule.command, fallbackCommand);
    assert.deepEqual(reloads().slice(before), [{ path: config, rules: ["claude", "hive"] }]);
    assert.match(result.stdout, new RegExp(`Installed hive's resume rule in ${config.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(result.stdout, /hive setup --rex-resume --uninstall/);
  });

  it("--install run twice leaves one block, replaced in place, and keeps init.lua's mode", async () => {
    const config = scratchConfig("twice", "-- top\n");
    chmodSync(config, 0o600);
    assert.equal((await hive(["setup", "--rex-resume", "--install"], config)).code, 0);
    writeFileSync(config, `${readFileSync(config, "utf8").replace(process.execPath, "/scratch/old-node/bin/node")}-- bottom\n`);
    const second = await hive(["setup", "--rex-resume", "--install"], config);
    assert.equal(second.code, 0, second.stdout + second.stderr);
    const text = readFileSync(config, "utf8");
    assert.equal(blocksIn(text), 1, text);
    assert.ok(text.startsWith("-- top\n") && text.endsWith(`${CLOSE}\n-- bottom\n`), text);
    assert.ok(!text.includes("/scratch/old-node/bin/node"), text);
    assert.deepEqual(hiveRule(config).rule.command, fallbackCommand);
    assert.equal(statSync(config).mode & 0o777, 0o600);
  });

  it("--install creates a missing init.lua and its directory", async () => {
    const config = scratchConfig("missing");
    const result = await hive(["setup", "--rex-resume", "--install"], config);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(blocksIn(readFileSync(config, "utf8")), 1);
    assert.deepEqual(hiveRule(config).rule.command, fallbackCommand);
  });

  it("--install writes through a symlinked init.lua and leaves the link a link", async () => {
    const real = scratchConfig("link-target", "-- dotfiles\n");
    const config = join(mkdtempSync(join(dirs.tmp, "cfg-link-")), "init.lua");
    symlinkSync(real, config);
    const result = await hive(["setup", "--rex-resume", "--install"], config);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.ok(lstatSync(config).isSymbolicLink());
    assert.equal(blocksIn(readFileSync(real, "utf8")), 1);
  });

  it("--install refuses an unmarked resume.trust.hive assignment and leaves init.lua and Rex alone", async () => {
    const original = 'rex.set("resume.trust.hive", {\n  command = { "/old/node", "/old/cli.js", "__rex-resume", rex.match.id },\n})\n';
    const config = scratchConfig("unmarked", original);
    const before = reloads().length;
    const result = await hive(["setup", "--rex-resume", "--install"], config);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /resume\.trust\.hive.*not managed by hive.*remove it/s);
    assert.equal(readFileSync(config, "utf8"), original);
    assert.equal(reloads().length, before);
  });

  it("--install refuses an init.lua rex config check already reports an error in, naming it as the file's own and not the edit's", async () => {
    const original = "-- mine\nbroken() --fake-rex:error\n";
    const config = scratchConfig("error", original);
    const before = reloads().length;
    const result = await hive(["setup", "--rex-resume", "--install"], config);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /init\.lua already has errors:.*fake rex: error marker.*fix them first/s);
    assert.doesNotMatch(result.stderr, /edited file/);
    assert.equal(readFileSync(config, "utf8"), original);
    assert.deepEqual(readdirSync(dirname(config)), ["init.lua"]);
    assert.equal(reloads().length, before);
  });

  it("--install refuses when the candidate's hive rule does not read back as the expected command", async () => {
    const config = scratchConfig("ignored", "-- mine\n");
    const before = reloads().length;
    fakeRexDo(dirs.tmp, "setServerInfo", { config_ignores_trust: true });
    try {
      const result = await hive(["setup", "--rex-resume", "--install"], config);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /did not read back/);
      assert.equal(readFileSync(config, "utf8"), "-- mine\n");
      assert.deepEqual(readdirSync(dirname(config)), ["init.lua"]);
      assert.equal(reloads().length, before);
    } finally {
      fakeRexDo(dirs.tmp, "setServerInfo", { config_ignores_trust: false });
    }
  });

  it("--uninstall removes the marked block, keeps the user's lines, and reloads; a second run reports nothing to remove", async () => {
    const config = scratchConfig("uninstall", "-- top\n");
    assert.equal((await hive(["setup", "--rex-resume", "--install"], config)).code, 0);
    writeFileSync(config, `${readFileSync(config, "utf8")}-- bottom\n`);
    const before = reloads().length;
    const removed = await hive(["setup", "--rex-resume", "--uninstall"], config);
    assert.equal(removed.code, 0, removed.stdout + removed.stderr);
    assert.equal(readFileSync(config, "utf8"), "-- top\n-- bottom\n");
    assert.equal(hiveRule(config), undefined);
    assert.deepEqual(reloads().slice(before), [{ path: config, rules: ["claude"] }]);
    const again = await hive(["setup", "--rex-resume", "--uninstall"], config);
    assert.equal(again.code, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /nothing to remove/);
    assert.equal(reloads().length, before + 1);
  });

  it("--install and --uninstall refuse an orphan open marker above the user's lines, naming its line, and leave the file byte-identical", async () => {
    const orphan = `-- top\n${OPEN}\nrex.bind('a', 'x')\nrex.bind('b', 'y')\n`;
    const config = scratchConfig("orphan", orphan);
    for (const verb of ["--install", "--uninstall"]) {
      const result = await hive(["setup", "--rex-resume", verb], config);
      assert.equal(result.code, 1, `${verb}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /marker lines do not pair up.*open marker on line 2.*fix them by hand/s);
      assert.equal(readFileSync(config, "utf8"), orphan);
    }
  });

  it("an orphan open marker above a complete block is refused, so the user's lines between them survive both commands", async () => {
    const block = `${OPEN}\nrex.set("resume.trust.hive", {\n  command = { "/old/node" },\n})\n${CLOSE}\n`;
    const original = `-- top\n${OPEN}\nrex.bind('a', 'x')\n\n${block}-- bottom\n`;
    const config = scratchConfig("orphan-block", original);
    for (const verb of ["--install", "--uninstall"]) {
      const result = await hive(["setup", "--rex-resume", verb], config);
      assert.equal(result.code, 1, `${verb}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /open markers on lines 2, 5.*close marker on line 9/s);
      assert.equal(readFileSync(config, "utf8"), original);
    }
  });

  it("a CRLF init.lua keeps CRLF endings through install, a stale re-install in place, and uninstall", async () => {
    const original = "-- top\r\n-- two\r\n";
    const config = scratchConfig("crlf", original);
    assert.equal((await hive(["setup", "--rex-resume", "--install"], config)).code, 0);
    const installed = readFileSync(config, "utf8");
    assert.equal(blocksIn(installed), 1);
    assert.doesNotMatch(installed, /[^\r]\n/, JSON.stringify(installed));
    assert.deepEqual(hiveRule(config).rule.command, fallbackCommand);
    writeFileSync(config, installed.replace(process.execPath, "/scratch/old-node/bin/node"));
    const again = await hive(["setup", "--rex-resume", "--install"], config);
    assert.equal(again.code, 0, again.stdout + again.stderr);
    assert.equal(readFileSync(config, "utf8"), installed);
    const removed = await hive(["setup", "--rex-resume", "--uninstall"], config);
    assert.equal(removed.code, 0, removed.stdout + removed.stderr);
    assert.equal(readFileSync(config, "utf8"), original);
  });

  it("--install keeps the previous init.lua's bytes in init.lua.hive-bak and prints that path", async () => {
    const original = "-- before the install\n";
    const config = scratchConfig("backup", original);
    const result = await hive(["setup", "--rex-resume", "--install"], config);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(`${config}.hive-bak`, "utf8"), original);
    assert.ok(result.stdout.includes(`${config}.hive-bak`), result.stdout);
  });

  it("--install refuses when init.lua changes while rex config check runs, keeping the concurrent edit", async () => {
    const config = scratchConfig("concurrent", "-- mine\n");
    fakeRexDo(dirs.tmp, "setServerInfo", { config_check_side_edit: config });
    try {
      const result = await hive(["setup", "--rex-resume", "--install"], config);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /changed while hive was checking it/);
      assert.equal(readFileSync(config, "utf8"), "-- mine\n-- edited meanwhile\n");
      assert.deepEqual(readdirSync(dirname(config)), ["init.lua"]);
    } finally {
      fakeRexDo(dirs.tmp, "setServerInfo", { config_check_side_edit: null });
    }
  });

  it("--install refuses a dangling init.lua symlink and leaves it a link to nothing", async () => {
    const dir = mkdtempSync(join(dirs.tmp, "cfg-dangling-"));
    const config = join(dir, "init.lua");
    const missing = join(dir, "gone", "init.lua");
    symlinkSync(missing, config);
    const result = await hive(["setup", "--rex-resume", "--install"], config);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /symlink to .*gone\/init\.lua, which does not exist/);
    assert.ok(lstatSync(config).isSymbolicLink());
    assert.equal(existsSync(missing), false);
  });

  it("a failed rex config reload exits non-zero after writing, and a re-run of the current rule retries the reload", async () => {
    const config = scratchConfig("reload", "-- mine\n");
    fakeRexDo(dirs.tmp, "stopServer");
    let failed;
    try {
      failed = await hive(["setup", "--rex-resume", "--install"], config);
    } finally {
      fakeRexDo(dirs.tmp, "restartServer");
    }
    assert.equal(failed.code, 1, failed.stdout + failed.stderr);
    assert.match(failed.stderr, /rex config reload failed/);
    assert.equal(blocksIn(readFileSync(config, "utf8")), 1, "the file is written before the reload");
    const before = reloads().length;
    const again = await hive(["setup", "--rex-resume", "--install"], config);
    assert.equal(again.code, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /already current; reloaded/);
    assert.equal(reloads().length, before + 1);
  });

  it("a filesystem error while writing prints one line and no stack trace", async () => {
    const config = scratchConfig("readonly", "-- mine\n");
    chmodSync(dirname(config), 0o500);
    try {
      const result = await hive(["setup", "--rex-resume", "--install"], config);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      const lines = result.stderr.trim().split("\n");
      assert.equal(lines.length, 1, result.stderr);
      assert.match(lines[0], /^hive setup --rex-resume: .*EACCES/);
    } finally {
      chmodSync(dirname(config), 0o755);
    }
    assert.equal(readFileSync(config, "utf8"), "-- mine\n");
  });

  it("isolateRex pins HIVE_BIN_DIR to a scratch dir for this process, fake.env and the child env", () => {
    for (const value of [process.env.HIVE_BIN_DIR, fake.env.HIVE_BIN_DIR, fake.childEnv.HIVE_BIN_DIR]) assert.ok(value?.startsWith(`${dirs.tmp}/`), String(value));
    assert.deepEqual(Object.keys(fake.childEnv).filter((k) => k.startsWith("HIVE_")), ["HIVE_BIN_DIR"]);
  });

  it("--install and --uninstall together, or either without --rex-resume, are refused", async () => {
    const config = scratchConfig("flags", "-- mine\n");
    const both = await hive(["setup", "--rex-resume", "--install", "--uninstall"], config);
    assert.equal(both.code, 1);
    const bare = await hive(["setup", "--install"], config);
    assert.equal(bare.code, 1);
    assert.match(bare.stderr, /--install goes with --rex-resume/);
    assert.equal(readFileSync(config, "utf8"), "-- mine\n");
  });

  it("bare --rex-resume leads with the one install command, prints the rule, and runs no rex", async () => {
    const config = scratchConfig("print", "-- mine\n");
    const before = rexCalls();
    const result = await hive(["setup", "--rex-resume"], config);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout.split("\n")[0], /hive setup --rex-resume --install/);
    assert.match(result.stdout, /rex\.set\("resume\.trust\.hive", \{/);
    assert.doesNotMatch(result.stdout, /never edits/);
    assert.equal(rexCalls(), before);
    assert.equal(readFileSync(config, "utf8"), "-- mine\n");
  });
});

describe("the installed rule against what hive records now", () => {
  it("doctor reads the rule as installed, then stale naming the old interpreter, then missing, each naming the install command", async () => {
    const config = scratchConfig("doctor", "-- mine\n");
    const env = { HIVE_TERMINAL: "rex", HIVE_NO_UPDATE_CHECK: "1" };
    assert.equal((await hive(["setup", "--rex-resume", "--install"], config, env)).code, 0);
    const current = (await hive(["doctor"], config, env)).stdout;
    assert.equal(ruleLine(current), "  ok    rex resume rule: installed");

    writeFileSync(config, readFileSync(config, "utf8").replace(process.execPath, "/scratch/old-node/bin/node"));
    const stale = (await hive(["doctor"], config, env)).stdout;
    assert.equal(ruleLine(stale), "  warn  rex resume rule: stale: names /scratch/old-node/bin/node");
    assert.match(stale, /rex resume rule[\s\S]*hive setup --rex-resume --install/);

    writeFileSync(config, "-- mine\n");
    const missing = (await hive(["doctor"], config, env)).stdout;
    assert.equal(ruleLine(missing), "  warn  rex resume rule: missing");
    assert.match(missing, /rex resume rule: missing[\s\S]*hive setup --rex-resume --install/);
  });

  it("doctor reports unknown when rex config check fails", async () => {
    const outside = join(dirname(dirs.tmp), "..", "outside-the-fake-scratch", "init.lua");
    const out = (await hive(["doctor"], outside, { HIVE_TERMINAL: "rex", HIVE_NO_UPDATE_CHECK: "1" })).stdout;
    assert.match(ruleLine(out) ?? "", /^ {2}warn {2}rex resume rule: unknown: /);
  });

  it("hive setup under Rex names the install command when the installed rule predates the dispatcher, edits nothing, and is quiet once it is current", async () => {
    const config = scratchConfig("repin", "-- mine\n");
    const bin = join(dirs.tmp, "bin-repin");
    const env = { HIVE_TERMINAL: "rex", HIVE_BIN_DIR: bin };
    assert.equal((await hive(["setup", "--rex-resume", "--install"], config, env)).code, 0);
    const installed = readFileSync(config, "utf8");
    assert.ok(installed.includes(JSON.stringify(process.execPath)), "installed before any dispatcher, so it names the interpreter");

    const repin = await hive(["setup", "--force"], config, env);
    assert.equal(repin.code, 0, repin.stdout + repin.stderr);
    assert.ok(existsSync(join(bin, "hive")));
    assert.match(repin.stdout, /^! Rex's hive resume rule is stale \(names .*\); update it with: hive setup --rex-resume --install$/m);
    assert.equal(readFileSync(config, "utf8"), installed, "setup never edits init.lua");

    assert.equal((await hive(["setup", "--rex-resume", "--install"], config, env)).code, 0);
    assert.equal(hiveRule(config).rule.command[4], join(bin, "hive"));
    const again = await hive(["setup", "--force"], config, env);
    assert.doesNotMatch(again.stdout, /resume rule is stale/);
  });

  it("after a re-pin to another interpreter, an installed dispatcher rule stays current with no edit to init.lua", async () => {
    const config = scratchConfig("node-upgrade", "-- mine\n");
    const bin = pinDispatcher("node-upgrade");
    const env = { HIVE_TERMINAL: "rex", HIVE_BIN_DIR: bin, HIVE_NO_UPDATE_CHECK: "1" };
    assert.equal((await hive(["setup", "--rex-resume", "--install"], config, env)).code, 0);
    const installed = readFileSync(config, "utf8");
    const otherNode = join(mkdtempSync(join(dirs.tmp, "upgraded-node-")), "node");
    writeFileSync(otherNode, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    chmodSync(otherNode, 0o755);
    pinDispatcher("node-upgrade", otherNode);
    assert.equal(ruleLine((await hive(["doctor"], config, env)).stdout), "  ok    rex resume rule: installed");
    assert.equal(readFileSync(config, "utf8"), installed);
  });

  it("hive setup with no terminal configured runs no rex, even with a stale rule installed", async () => {
    const config = scratchConfig("no-terminal", `${OPEN}\nrex.set("resume.trust.hive", {\n  command = { "/old/node" },\n})\n${CLOSE}\n`);
    const before = rexCalls();
    const result = await hive(["setup", "--force"], config, { HIVE_BIN_DIR: join(dirs.tmp, "bin-no-terminal") });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /resume rule/);
    assert.equal(rexCalls(), before);
  });
});
