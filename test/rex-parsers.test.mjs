import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { REPO, clearHiveEnv, isolateTmux, scratchDirs, tmux, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("rex parser tests");
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;

const T = await import("../dist/tmux.js");
const { normalizeRexVt } = await import("../dist/terminal/rex.js");

const REX_FIXTURES = join(REPO, "test", "fixtures", "rex");
const PANE_FIXTURES = join(REPO, "test", "fixtures", "panes");
const rexFixture = (name) => readFileSync(join(REX_FIXTURES, name), "utf8");

const sessions = [];
after(() => {
  for (const s of sessions) {
    try {
      tmux("kill-session", "-t", `=${s}`);
    } catch {}
  }
  cleanup();
});

describe("normalizeRexVt", () => {
  it("expands CSI n C into n spaces, with a missing n meaning one", () => {
    assert.equal(normalizeRexVt("a\x1b[3Cb\x1b[Cc\x1b[1Cd"), "a   b c d");
  });

  it("turns Rex's CRLF rows into tmux's LF rows and drops stray carriage returns", () => {
    assert.equal(normalizeRexVt("one\r\ntwo\rthree\r\n"), "one\ntwothree\n");
  });

  it("leaves SGR and OSC sequences for the classifiers, which already strip them", () => {
    const raw = "\x1b[0m\x1b[1mbold\x1b[0m \x1b]8;;https://x\x1b\\link";
    assert.equal(normalizeRexVt(raw), raw);
  });

  it("leaves no cursor-forward sequence in any real Rex fixture", () => {
    for (const name of readdirSync(REX_FIXTURES).filter((f) => f.endsWith(".vt"))) {
      const text = normalizeRexVt(rexFixture(name));
      assert.doesNotMatch(text, /\x1b\[\d*C/, name);
      assert.doesNotMatch(text, /\r/, name);
    }
  });
});

describe("Rex vt captures classify the same as their tmux counterparts", () => {
  it("Rex vt captures classify the same as their tmux counterparts", () => {
    const idle = T.inputBoxSnapshotFromRaw(normalizeRexVt(rexFixture("claude-idle.vt")));
    assert.equal(idle.box?.state, "ghost", "the README's empty box shows claude's dim placeholder, which InputBoxState calls ghost");
    assert.equal(T.holdsHumanInput(idle.box), false);
    const typing = T.inputBoxSnapshotFromRaw(normalizeRexVt(rexFixture("claude-typing.vt")));
    assert.equal(typing.box?.state, "pending", "the README's human-text is InputBoxState pending");
    assert.notEqual(typing.box?.text, "");
    assert.equal(T.holdsHumanInput(typing.box), true);
    for (const name of ["claude-dialog.vt", "claude-trust-dialog.vt"]) {
      const check = T.paneChoiceCheckFromRaw(normalizeRexVt(rexFixture(name)));
      assert.equal(check.awaitingChoice, true, name);
    }
    for (const name of ["claude-idle.vt", "claude-typing.vt"]) {
      assert.equal(T.paneChoiceCheckFromRaw(normalizeRexVt(rexFixture(name))).awaitingChoice, false, name);
    }
  });

  it("the trust dialog is only recognised once its cursor-forward gaps are spaces", () => {
    assert.equal(T.paneChoiceCheckFromRaw(rexFixture("claude-trust-dialog.vt")).awaitingChoice, false);
    assert.equal(T.paneChoiceCheckFromRaw(normalizeRexVt(rexFixture("claude-trust-dialog.vt"))).awaitingChoice, true);
  });

  it("an idle box gives a trailer view and a dialog gives none", () => {
    assert.equal(T.claudeTrailerViewFromRaw(normalizeRexVt(rexFixture("claude-idle.vt")))?.box.state, "ghost");
    assert.equal(T.claudeTrailerViewFromRaw(normalizeRexVt(rexFixture("claude-dialog.vt"))), null);
  });

});

const capture = (pane, styled) =>
  tmux("capture-pane", "-p", ...(styled ? ["-e"] : []), "-t", pane, "-S", `-${T.tailCaptureLines()}`);

describe("every tmux pane fixture reads the same through the FromRaw variants as through the pane", () => {
  const fixtures = readdirSync(PANE_FIXTURES).filter((f) => f.endsWith(".txt"));

  it("FromRaw on a pane's own capture equals the target-taking classifier, for the whole corpus", { skip: hasTmux ? false : "tmux is not installed" }, async () => {
    assert.ok(fixtures.length > 40, `expected the pane corpus, found ${fixtures.length}`);
    let compared = 0;
    for (const [i, file] of fixtures.entries()) {
      const session = `rexparse-${process.pid}-${i}`;
      sessions.push(session);
      const pane = tmux(
        "new-session", "-d", "-x", "200", "-y", "50", "-s", session, "-P", "-F", "#{pane_id}",
        `cat '${join(PANE_FIXTURES, file)}'; sleep 600`,
      ).trim();
      await until(() => capture(pane, false).trim() !== "", 3000, 25, `${file} to render`);
      const plain = capture(pane, false);
      const styled = capture(pane, true);
      const title = T.paneTitle(pane);
      assert.deepEqual(T.inputBoxSnapshotFromRaw(styled), T.inputBoxSnapshot(pane), `${file} inputBoxSnapshot`);
      assert.deepEqual(T.claudeTrailerViewFromRaw(styled), T.claudeTrailerView(pane), `${file} claudeTrailerView`);
      assert.deepEqual(T.paneChoiceCheckFromRaw(plain), T.paneChoiceCheck(pane), `${file} paneChoiceCheck`);
      assert.deepEqual(T.codexInputBoxStateFromRaw(styled, title), T.codexInputBoxState(pane), `${file} codexInputBoxState`);
      assert.deepEqual(T.codexTrailerViewFromRaw(styled), T.codexTrailerView(pane), `${file} codexTrailerView`);
      assert.deepEqual(T.codexPaneChoiceCheckFromRaw(plain, title), T.codexPaneChoiceCheck(pane), `${file} codexPaneChoiceCheck`);
      tmux("kill-session", "-t", `=${session}`);
      compared += 1;
    }
    assert.equal(compared, fixtures.length);
  });

  it("the corpus exercises every input-box state and both dialog answers through the FromRaw variants", () => {
    const states = new Set();
    const choices = new Set();
    for (const file of fixtures) {
      const raw = readFileSync(join(PANE_FIXTURES, file), "utf8");
      states.add(T.inputBoxSnapshotFromRaw(raw).box?.state ?? "none");
      states.add(`codex:${T.codexInputBoxStateFromRaw(raw, null)?.state ?? "none"}`);
      choices.add(T.paneChoiceCheckFromRaw(raw).awaitingChoice);
      choices.add(`codex:${T.codexPaneChoiceCheckFromRaw(raw, null).awaitingChoice}`);
    }
    for (const state of ["empty", "ghost", "pending", "none", "codex:empty", "codex:ghost", "codex:pending"]) {
      assert.ok(states.has(state), `no fixture reached ${state}: ${[...states].join(", ")}`);
    }
    for (const choice of [true, false, "codex:true", "codex:false"]) assert.ok(choices.has(choice), String(choice));
  });
});
