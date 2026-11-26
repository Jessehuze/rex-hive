import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { REPO } from "./helpers.mjs";

const SRC = join(REPO, "src");

const FACADE_NAMES = [
  "sendText", "capturePane", "captureRawPane", "targetLive", "targetLiveProbe", "rowLive", "rowAlive",
  "rowLiveProbe", "rowAliveProbe", "rowOwnership", "observeRowOwnership", "liveTargets", "targetAlive",
  "targetPid", "panePid", "panePidForRecord", "paneProcessExited", "paneInCopyMode", "cancelCopyMode",
  "paneCurrentCommand", "paneTitle", "inputBoxSnapshot", "inputBoxState", "claudeTrailerView",
  "paneChoiceCheck", "paneAwaitingChoice", "codexInputBoxState", "codexTrailerView", "codexPaneChoiceCheck",
  "pollPaneReadiness", "waitForPaneInput", "waitForPaneEstablished", "setRemainOnExit", "captureFinalScreen",
  "foreignSocket",
];

const IMPORT_ALLOWLIST = [];

const PENDING_TASK_2 = [
  "src/cli.ts",
  "src/spawn.ts",
  "src/tools/agents.ts",
  "src/processes.ts",
  "src/leadHandoffCli.ts",
];

const EXEC_ALLOWLIST = ["src/tmux.ts", "src/terminal.ts", "src/rexCli.ts", ...PENDING_TASK_2];
const EXEC_ALLOWED_PREFIXES = ["src/terminal/"];

function listTs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listTs(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

const isFacadeFile = (rel) => rel === "src/terminal.ts" || rel.startsWith("src/terminal/");

function tmuxImportViolations(rel, text) {
  if (isFacadeFile(rel)) return [];
  const found = [];
  const staticImport = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(?:\.\.?\/)+tmux\.js"/g;
  const dynamicImport = /const\s+\{([^}]*)\}\s*=\s*await\s+import\("(?:\.\.?\/)+tmux\.js"\)/g;
  for (const re of [staticImport, dynamicImport]) {
    for (const match of text.matchAll(re)) {
      for (const raw of match[1].split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+|\s*:\s*/)[0].trim();
        if (FACADE_NAMES.includes(name)) found.push(`${rel}: ${name}`);
      }
    }
  }
  return found;
}

function execViolations(rel, text) {
  if (EXEC_ALLOWLIST.includes(rel) || EXEC_ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) return [];
  return /\("tmux"|\btmux\(|\("rex"/.test(text) ? [rel] : [];
}

const sources = listTs(SRC).map((path) => ({ rel: relative(REPO, path), text: readFileSync(path, "utf8") }));

describe("rex seam guard", () => {
  it("no src file imports a terminal-touching tmux.js export outside the facade", () => {
    const violations = sources
      .filter(({ rel }) => !IMPORT_ALLOWLIST.includes(rel))
      .flatMap(({ rel, text }) => tmuxImportViolations(rel, text));
    const files = [...new Set(violations.map((v) => v.split(":")[0]))];
    assert.deepEqual(files, [], `import these from the terminal facade:\n${violations.join("\n")}`);
  });

  it("only tmux.ts, terminal files and rexCli.ts execute tmux or rex", () => {
    const violations = sources.flatMap(({ rel, text }) => execViolations(rel, text));
    assert.deepEqual(violations, []);
  });

  it("every pending-task-2 file still executes tmux directly", () => {
    const stale = PENDING_TASK_2.filter((rel) => !sources.some((s) => s.rel === rel && /\("tmux"|\btmux\(|\("rex"/.test(s.text)));
    assert.deepEqual(stale, []);
  });

  it("the facade exports every name the guard treats as terminal-touching", () => {
    const facade = sources.find((s) => s.rel === "src/terminal.ts");
    assert.ok(facade, "src/terminal.ts exists");
    for (const name of [...FACADE_NAMES, "isRexTarget", "isRexSocket", "rexServerOf"]) {
      assert.match(facade.text, new RegExp(`\\b${name}\\b`), name);
    }
  });

  it("guard catches a planted violation", () => {
    const planted = 'import { sendText } from "./tmux.js";\n';
    assert.equal(tmuxImportViolations("src/x.ts", planted).length, 1);
    assert.equal(tmuxImportViolations("src/terminal.ts", planted).length, 0);
    assert.equal(tmuxImportViolations("src/x.ts", 'import { shellQuote } from "./tmux.js";').length, 0);
    assert.equal(execViolations("src/x.ts", 'execFileSync("rex", [])').length, 1);
  });
});
