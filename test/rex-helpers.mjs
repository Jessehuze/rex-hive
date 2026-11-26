import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { REPO } from "./helpers.mjs";

export const FAKE_REX_DIR = join(REPO, "test", "fixtures", "fake-rex");
const FAKE_REX_MAIN = join(FAKE_REX_DIR, "fake-rex.mjs");

const statePath = (tmp) => join(tmp, "fake-rex.json");
const callsPath = (tmp) => join(tmp, "fake-rex-calls.jsonl");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function killAll(tmp) {
  if (!existsSync(statePath(tmp))) return;
  let state;
  try {
    state = readJson(statePath(tmp));
  } catch {
    return;
  }
  const pids = new Set(state.pids ?? []);
  for (const block of Object.values(state.blocks ?? {})) {
    if (block.relay_pid) pids.add(block.relay_pid);
  }
  for (const pid of pids) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {}
    }
  }
  for (const block of Object.values(state.blocks ?? {})) {
    try {
      if (block.child_pid) process.kill(block.child_pid, "SIGKILL");
    } catch {}
  }
}

export function isolateRex(tmp) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("REX_") || key === "OSC7577_TOKEN" || key.startsWith("FAKE_REX_")) delete process.env[key];
  }
  delete process.env.HIVE_REX_TIMEOUT;
  process.env.PATH = `${FAKE_REX_DIR}${delimiter}${process.env.PATH ?? ""}`;
  process.env.REX_SERVER = `unix://${tmp}/fake-rex.sock`;
  process.env.FAKE_REX_STATE = statePath(tmp);
  writeFileSync(
    statePath(tmp),
    JSON.stringify({ address: process.env.REX_SERVER, server: "running", revision: 0, sessions: [], windows: [], blocks: {}, closed: [], pids: [], performed: [] }),
  );
  writeFileSync(callsPath(tmp), "");
  process.on("exit", () => killAll(tmp));
  return {
    env: { ...process.env },
    state: () => readJson(statePath(tmp)),
    calls: () =>
      readFileSync(callsPath(tmp), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    cleanup: () => killAll(tmp),
  };
}

export function fakeRexDo(tmp, op, args = {}) {
  const out = execFileSync(process.execPath, [FAKE_REX_MAIN, "__fake", op, JSON.stringify(args)], {
    env: { ...process.env, FAKE_REX_STATE: statePath(tmp) },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

const DIRECT_REX_EXEC = /\b(?:execFileSync|execFile|spawnSync|spawn|execSync|exec)\(\s*["'`]rex["'`]/;

export function rexCallScanViolations(rel, text) {
  return DIRECT_REX_EXEC.test(text) ? [rel] : [];
}

export async function waitFor(check, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
