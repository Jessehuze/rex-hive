import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { REPO, clearHiveEnv, isolateTmux, scratchDirs } from "./helpers.mjs";
import { fakeRexDo, isolateRex } from "./rex-helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("rex core pane operation tests");
const dirs = scratchDirs();
const fake = isolateRex(dirs.tmp);
clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const REX_ADDR = process.env.REX_SERVER;

const { db, migrate } = await import("../dist/db.js");
migrate();
await import("../dist/rexInUse.js");
const terminal = await import("../dist/terminal.js");
const { janitor } = await import("../dist/scheduler.js");
const { rexApi } = await import("../dist/rexCli.js");
const { REX_CAPTURE_BYTES_PER_LINE, rexStopProcess } = await import("../dist/terminal/rex.js");

after(() => {
  fake.cleanup();
  cleanupTmux();
  db.close();
});

const realCalls = () => fake.calls().filter((c) => c.argv[0] !== "__fake");
const callsSince = (n) => realCalls().slice(n);
const paramsOf = (call) => {
  const i = call.argv.indexOf("call");
  return i >= 0 ? { method: call.argv[i + 1], params: JSON.parse(call.argv[i + 2] ?? "{}") } : null;
};

function newBlock(label, command = ["sleep", "600"], size = undefined) {
  const made = rexApi(REX_ADDR, "session.create", {
    label: `s-${label}`,
    initial_windows: [{ window_label: label, layout: { block: { flavor: "com.superlogical.terminal.shell", label, options: { shell: "none", login: false, command, ...(size ? { size } : {}) } } } }],
  });
  return { session: made.session_id, window: made.initial_windows[0].window_id, block: made.initial_windows[0].block_ids[0] };
}

const eventsOf = (block) => fake.state().blocks[block].events;

describe("with no Rex configured", () => {
  it("liveTargets and the janitor make no rex call", () => {
    const before = realCalls().length;
    const snapshot = terminal.liveTargets();
    assert.equal(snapshot?.rex, undefined);
    janitor(snapshot);
    janitor();
    assert.deepEqual(callsSince(before), []);
  });
});

describe("Rex core pane operations", () => {
  it("paste carries metacharacters and 20k chars intact", async () => {
    const b = newBlock("paste");
    const body = `$HOME & "q" \`x\`\nsecond line\n${"a".repeat(20_000)}`;
    await terminal.sendText(b.block, body, true);
    const events = eventsOf(b.block);
    assert.deepEqual(events.map((e) => e.type), ["paste", "key"]);
    assert.equal(events[0].payload.text, body);
    assert.deepEqual(events.filter((e) => e.type === "key").map((e) => e.payload.key), ["enter"]);
  });

  it("unsafe control char is refused before any rex call", async () => {
    const b = newBlock("unsafe");
    const before = realCalls().length;
    await assert.rejects(terminal.sendText(b.block, "clear\x1b[2J", true), /control character/);
    assert.deepEqual(callsSince(before), []);
    assert.deepEqual(eventsOf(b.block), []);
  });

  it("a block with bracketed paste off is refused rather than typed into raw", async () => {
    const b = newBlock("unbracketed");
    fakeRexDo(dirs.tmp, "setBracketedPaste", { block_id: b.block, on: false });
    await assert.rejects(terminal.sendText(b.block, "hello", true), /bracketed paste off/);
    assert.deepEqual(eventsOf(b.block), []);
  });

  it("capture is tail-bounded on a block with 5MB of box-drawing scrollback", () => {
    const b = newBlock("big");
    const rows = Array.from({ length: 100_000 }, (_, i) => `│ row ${String(i).padStart(6, "0")} ${"─".repeat(13)} │`);
    const file = join(dirs.tmp, "big-screen.txt");
    const content = `${rows.join("\r\n")}\r\n`;
    const total = Buffer.byteLength(content);
    assert.ok(total > 5_000_000, `the fixture must exceed 5MB, got ${total}`);
    writeFileSync(file, content);
    fakeRexDo(dirs.tmp, "setScreenFile", { block_id: b.block, file });
    const lines = 40;
    const screen = 24;
    const before = realCalls().length;
    const out = terminal.capturePane(b.block, lines).split("\n");
    assert.deepEqual(out, rows.slice(-lines));
    const formats = callsSince(before).map(paramsOf).filter((c) => c?.params.method === "format");
    assert.equal(formats.length, 1);
    assert.equal(formats[0].params.args.max_bytes, (screen + lines) * REX_CAPTURE_BYTES_PER_LINE);
    const reads = callsSince(before).map(paramsOf).filter((c) => c?.params.method === "blob_read");
    assert.equal(reads.length, 1, "the whole tail comes from one blob_read, so a mid-character offset cannot drift");
    const textBytes = Buffer.from(rows.join("\n"));
    const textTotal = textBytes.length;
    assert.equal(textBytes[textTotal - (screen + lines) * REX_CAPTURE_BYTES_PER_LINE] & 0xc0, 0x80, "the tail starts inside a box-drawing character");
    assert.ok(reads.every((c) => c.params.args.offset >= textTotal - (screen + lines) * REX_CAPTURE_BYTES_PER_LINE), "it reads only the tail");
    const raw = terminal.captureRawPane(b.block, lines).split("\n");
    assert.deepEqual(raw, rows.slice(-(screen + lines)), "captureRawPane is the visible screen plus the history lines, like capture-pane -S");
    assert.ok(!raw.join("").includes("\uFFFD"), "a mid-character offset never leaks a replacement character");
  });

  it("a reply with an id but no total is read forward to the end", () => {
    const b = newBlock("no-total");
    const rows = Array.from({ length: 3000 }, (_, i) => `│ line ${i} ─────────── │`);
    const file = join(dirs.tmp, "no-total.txt");
    writeFileSync(file, `${rows.join("\r\n")}\r\n`);
    fakeRexDo(dirs.tmp, "setScreenFile", { block_id: b.block, file });
    process.env.FAKE_REX_FORMAT_NO_TOTAL = "1";
    try {
      assert.deepEqual(terminal.capturePane(b.block, 10).split("\n"), rows.slice(-10));
    } finally {
      delete process.env.FAKE_REX_FORMAT_NO_TOTAL;
    }
  });

  it("a tall block with a top-anchored dialog or input box reads the whole visible screen, not its blank bottom rows", () => {
    const dialog = readFileSync(join(REPO, "test", "fixtures", "panes", "folder-trust-dialog.txt"), "utf8").replace(/\n+$/, "");
    const tallDialog = newBlock("tall-dialog", ["sleep", "600"], { columns: 120, rows: 80 });
    fakeRexDo(dirs.tmp, "setScreen", { block_id: tallDialog.block, text: dialog });
    assert.equal(terminal.paneChoiceCheck(tallDialog.block).awaitingChoice, true);
    const idle = readFileSync(join(REPO, "test", "fixtures", "rex", "claude-idle.vt"), "utf8");
    const tallIdle = newBlock("tall-idle", ["sleep", "600"], { columns: 80, rows: 80 });
    fakeRexDo(dirs.tmp, "setScreen", { block_id: tallIdle.block, text: idle });
    assert.equal(terminal.inputBoxSnapshot(tallIdle.block)?.box?.state, "ghost");
    assert.equal(terminal.paneChoiceCheck(tallIdle.block).awaitingChoice, false);
  });

  it("an empty target.resolve reply is a failed observation, never a closed block", () => {
    const b = newBlock("empty-resolve");
    process.env.FAKE_REX_EMPTY_ON = "target.resolve";
    try {
      assert.equal(terminal.paneProcessExited(b.block), null);
    } finally {
      delete process.env.FAKE_REX_EMPTY_ON;
    }
  });

  it("block moved to another session is still live and receives text", async () => {
    const b = newBlock("mover", ["cat"]);
    await terminal.sendText(b.block, "before the move", true);
    const moved = fakeRexDo(dirs.tmp, "transferWindow", { window_id: b.window, session_label: "elsewhere" });
    assert.notEqual(moved.session_id, b.session);
    assert.equal(terminal.targetLive(b.block), true);
    await terminal.sendText(b.block, "after the move", true);
    const events = eventsOf(b.block);
    assert.deepEqual(events.map((e) => e.type), ["paste", "key", "paste", "key"]);
    assert.deepEqual(events.filter((e) => e.type === "paste").map((e) => e.payload.text), ["before the move", "after the move"]);
  });

  it("copy mode is always false on Rex", () => {
    const b = newBlock("copy");
    const before = realCalls().length;
    assert.equal(terminal.paneInCopyMode(b.block), false);
    assert.equal(terminal.cancelCopyMode(b.block), false);
    assert.deepEqual(callsSince(before), [], "neither asks Rex anything");
  });

  it("keys map from tmux names to Rex key names", () => {
    const b = newBlock("keys", ["cat"]);
    terminal.sendKeys(b.block, ["Escape", "BTab", "Up", "Down", "Tab"]);
    assert.deepEqual(eventsOf(b.block).map((e) => e.payload.key), ["escape", "shift+tab", "up", "down", "tab"]);
    assert.throws(() => terminal.sendKeys(b.block, ["Enter", "NoSuchKey"]), /no Rex key/);
    assert.equal(eventsOf(b.block).length, 5, "an unmapped key refuses the whole list before any key is sent");
  });

  it("title reads terminal.title and a closed block's title is null", () => {
    const b = newBlock("titled");
    fakeRexDo(dirs.tmp, "setTitle", { block_id: b.block, title: "✳ working" });
    assert.equal(terminal.paneTitle(b.block), "✳ working");
    fakeRexDo(dirs.tmp, "closeBlock", { block_id: b.block });
    assert.equal(terminal.paneTitle(b.block), null);
  });

  it("probe names the child pid and argv, and a closed block probes false", () => {
    const b = newBlock("probed");
    const pid = String(fake.state().blocks[b.block].child_pid);
    assert.deepEqual(terminal.targetLiveProbe(b.block), { live: true, pid });
    assert.equal(terminal.panePid(b.block), pid);
    assert.equal(terminal.paneCurrentCommand(b.block), "sleep");
    fakeRexDo(dirs.tmp, "closeBlock", { block_id: b.block });
    assert.deepEqual(terminal.targetLiveProbe(b.block), { live: false, pid: null });
    assert.equal(terminal.paneProcessExited(b.block), true);
  });

  it("killPane closes the block through block.close in the block's current session", () => {
    const b = newBlock("closer");
    fakeRexDo(dirs.tmp, "transferWindow", { window_id: b.window, session_label: "closer-elsewhere" });
    terminal.killPane(b.block);
    assert.ok(fake.state().closed.includes(b.block));
  });

  it("rexStopProcess closes a block whose program exits on ctrl+c without waiting out the timeout", () => {
    const b = newBlock("stop-exits");
    const started = Date.now();
    rexStopProcess(b.block, 5000);
    assert.ok(Date.now() - started < 4000, "it returned once the program exited");
    assert.ok(fake.state().closed.includes(b.block));
  });

  it("rexStopProcess closes a block that ignores ctrl+c once the timeout passes", () => {
    const b = newBlock("stop-ignores", ["/bin/sh", "-c", "trap '' INT; while :; do sleep 1; done"]);
    const started = Date.now();
    rexStopProcess(b.block, 600);
    assert.ok(Date.now() - started >= 600, "it waited the timeout out");
    assert.ok(fake.state().closed.includes(b.block));
  });
});
