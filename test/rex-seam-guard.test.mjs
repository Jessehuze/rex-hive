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

const PURE_TMUX_EXPORTS = [
  "AliveSnapshot", "DEFAULT_LAYOUT", "InputBoxSnapshot", "InputBoxState", "Liveness", "ORPHAN_MIN_AGE_MS",
  "OrphanScratchServers", "OwnedWindow", "PROCESSES_LAYOUT", "PaneVisibility", "ProjectWindows",
  "RAW_ATTACH_TMUX_CONFIG", "RowOwnership", "RowPaneIdentity", "SESSION_PREFIX", "TEXT_ALLOWED_CONTROL_CHARS",
  "TMUX_DOC", "TMUX_NOT_INSTALLED_MESSAGE", "TmuxError", "TmuxTimeoutError", "TrailerView", "WINDOW_LAYOUTS",
  "WindowLayout", "controlModeFor", "describePaneChoice", "findUnsafeControlChar", "isPaneTarget",
  "isViewSessionName", "isWindowLayout", "maskChoiceMarker", "observationFailed", "orphansWorthWarningAbout",
  "ownershipLiveness", "processesPaneTitle", "processesWindowName", "renderAttachCommand", "renderTrailerView",
  "retainOnExitArgs", "sanitizeEventForDisplay", "sanitizeTail", "sessionName", "shellQuote", "shownPaneTitle",
  "sleep", "stripControlBytes", "tailCaptureLines", "tmuxNotInstalled", "tmuxSaysNothingThere",
  "tmuxTimeoutOverride", "windowTitle",
];

const PENDING_FACADE_NAMES = [
  "adoptableWindow", "appendGlobalHook", "applyLayout", "claimInitialWindow", "codexPaneHasInputBox",
  "configureHiveWindow", "createWindow", "crossServerRefusal", "ensureAttached", "ensureSession",
  "findProcessesWindow", "findProjectWindow", "globalHooks", "holdsHumanInput", "listOwnedWindows",
  "makeProcessesWindow", "orphanScratchServers", "paneEnvPath", "paneHasInputBox", "paneIsAloneInWindow",
  "paneReissued", "paneVisibility", "paneWindow", "projectWindows", "replaceGlobalHooks", "resolveAttachTarget",
  "resolveInTmuxTarget", "setPaneTitle", "tmux", "tmuxSocketPath", "tmuxWithClientPath", "untrustedTmuxServer",
  "windowLayout", "windowOwner",
];

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

const TMUX_SPECIFIER = /"(?:\.\.?\/)+tmux\.js"/g;
const STATIC_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(?:\.\.?\/)+tmux\.js"/g;
const DYNAMIC_IMPORT = /const\s+\{([^}]*)\}\s*=\s*await\s+import\("(?:\.\.?\/)+tmux\.js"\)/g;

function importedTmuxNames(text) {
  const names = [];
  let plain = 0;
  for (const re of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
    for (const match of text.matchAll(re)) {
      plain += 1;
      for (const raw of match[1].split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+|\s*:\s*/)[0].trim();
        if (name) names.push(name);
      }
    }
  }
  const unsupportedForms = [...text.matchAll(TMUX_SPECIFIER)].length - plain;
  return { names, unsupportedForms };
}

function tmuxImportViolations(rel, text) {
  if (isFacadeFile(rel)) return [];
  const { names, unsupportedForms } = importedTmuxNames(text);
  const found = names.filter((name) => !PURE_TMUX_EXPORTS.includes(name)).map((name) => `${rel}: ${name}`);
  if (unsupportedForms > 0) found.push(`${rel}: unsupported tmux.js import form`);
  return found;
}

const EXEC_CALL = /\("tmux"|\btmux\(|\("rex"/;

function execViolations(rel, text) {
  if (EXEC_ALLOWLIST.includes(rel) || EXEC_ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) return [];
  return EXEC_CALL.test(text) ? [rel] : [];
}

const sources = listTs(SRC).map((path) => ({ rel: relative(REPO, path), text: readFileSync(path, "utf8") }));

describe("rex seam guard", () => {
  it("no src file imports a terminal-touching tmux.js export outside the facade", () => {
    const violations = sources
      .filter(({ rel }) => !IMPORT_ALLOWLIST.includes(rel))
      .flatMap(({ rel, text }) => tmuxImportViolations(rel, text));
    const unlisted = violations.filter((v) => !PENDING_FACADE_NAMES.includes(v.split(": ")[1]));
    assert.deepEqual(unlisted, [], "import these from the terminal facade or list them as pure or pending");
  });

  it("every pending facade name is still imported directly from tmux.js and is not pure", () => {
    const imported = new Set(sources.flatMap(({ rel, text }) => (isFacadeFile(rel) ? [] : importedTmuxNames(text).names)));
    assert.deepEqual(PENDING_FACADE_NAMES.filter((n) => !imported.has(n)), []);
    assert.deepEqual(PENDING_FACADE_NAMES.filter((n) => PURE_TMUX_EXPORTS.includes(n)), []);
  });

  it("only tmux.ts, terminal files and rexCli.ts execute tmux or rex", () => {
    const violations = sources.flatMap(({ rel, text }) => execViolations(rel, text));
    assert.deepEqual(violations, []);
  });

  it("every pending-task-2 file still executes tmux directly", () => {
    const stale = PENDING_TASK_2.filter((rel) => !sources.some((s) => s.rel === rel && EXEC_CALL.test(s.text)));
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
    assert.equal(tmuxImportViolations("src/x.ts", 'import { brandNewPaneThing } from "./tmux.js";').length, 1);
    for (const form of [
      'export { shellQuote } from "./tmux.js";',
      'import * as t from "./tmux.js";',
      'import t from "./tmux.js";',
      'import t, { shellQuote } from "./tmux.js";',
      'const s = (await import("./tmux.js")).shellQuote;',
      'const t = await import("./tmux.js");',
    ]) {
      assert.equal(tmuxImportViolations("src/x.ts", form).length, 1, form);
    }
    assert.equal(execViolations("src/x.ts", 'execFileSync("rex", [])').length, 1);
    assert.equal(execViolations("src/x.ts", 'spawnSync("tmux", [])').length, 1);
    assert.equal(execViolations("src/x.ts", 'tmux("kill-pane")').length, 1);
    assert.equal(execViolations("src/terminal.ts", 'spawnSync("tmux", [])').length, 0);
    assert.equal(execViolations("src/terminal.ts", 'tmux("kill-pane")').length, 0);
  });
});
