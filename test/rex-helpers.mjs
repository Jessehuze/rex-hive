import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { killRelays, liveRelays } from "../scripts/rex-relay-leaks.mjs";
import { REPO } from "./helpers.mjs";

export const FAKE_REX_DIR = join(REPO, "test", "fixtures", "fake-rex");
const FAKE_REX_MAIN = join(FAKE_REX_DIR, "fake-rex.mjs");

const statePath = (tmp) => join(tmp, "fake-rex.json");
const callsPath = (tmp) => join(tmp, "fake-rex-calls.jsonl");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function killAll(tmp) {
  killRelays(liveRelays(statePath(tmp)));
}

export function isolateRex(tmp, { ownerPid = process.pid } = {}) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("REX_") || key === "OSC7577_TOKEN" || key.startsWith("FAKE_REX_")) delete process.env[key];
  }
  delete process.env.HIVE_REX_TIMEOUT;
  process.env.PATH = `${FAKE_REX_DIR}${delimiter}${process.env.PATH ?? ""}`;
  process.env.REX_SERVER = `unix://${tmp}/fake-rex.sock`;
  process.env.FAKE_REX_STATE = statePath(tmp);
  process.env.FAKE_REX_OWNER = String(ownerPid);
  process.env.REX_CONFIG = join(tmp, "rex-config", "init.lua");
  writeFileSync(
    statePath(tmp),
    JSON.stringify({ address: process.env.REX_SERVER, server: "running", revision: 0, sessions: [], windows: [], blocks: {}, closed: [], relays: [], performed: [] }),
  );
  writeFileSync(callsPath(tmp), "");
  if (process.env.HIVE_REX_RELAY_MANIFEST) {
    try {
      appendFileSync(process.env.HIVE_REX_RELAY_MANIFEST, `${statePath(tmp)}\n`);
    } catch {}
  }
  process.on("exit", () => killAll(tmp));
  return {
    env: { ...process.env },
    state: () => readJson(statePath(tmp)),
    calls: () =>
      readFileSync(callsPath(tmp), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    configPath: process.env.REX_CONFIG,
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

const REACHES_REX = [
  /\brexCli\.js\b/,
  /fake-rex/,
  /\b(?:execFileSync|execFile|spawnSync|spawn|execSync|exec)\(\s*["'`]rex\b/,
  /["'`](?:[^"'`\n]*[;&|]\s*)?rex\s+(?:--|-S\b|api\b|do\b|whoami\b|send-key\b|wait\b)/,
  /=\s*["'`]rex["'`]/,
];
const TOP_LEVEL_ISOLATE = /^(?![\s/]).*\bisolateRex\(/m;

export function rexCallScanViolations(rel, text) {
  if (rel === "test/rex-helpers.mjs") return [];
  if (!REACHES_REX.some((re) => re.test(text))) return [];
  return TOP_LEVEL_ISOLATE.test(text) ? [] : [rel];
}

export async function waitFor(check, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
