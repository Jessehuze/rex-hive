import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const RELAY_MARKER = "fake-rex/relay.mjs";

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function processTable() {
  try {
    return execFileSync("ps", ["-A", "-o", "pid=,pgid=,command="], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map(([, pid, pgid, command]) => ({ pid: Number(pid), pgid: Number(pgid), command }));
  } catch {
    return null;
  }
}

export function relayStillOurs(relay, table) {
  return table.some(
    (p) => p.pgid === relay.relay_pid && ((p.pid === relay.relay_pid && p.command.includes(RELAY_MARKER)) || p.pid === relay.child_pid),
  );
}

export function liveRelays(statePath, table = processTable()) {
  if (!table) return [];
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return [];
  }
  return (state.relays ?? []).filter((relay) => relay.relay_pid > 0 && relayStillOurs(relay, table));
}

export function killRelays(relays) {
  for (const relay of relays) {
    try {
      process.kill(-relay.relay_pid, "SIGKILL");
    } catch {}
  }
}

export function checkRelayLeaks(manifest, { settleMs = 3000 } = {}) {
  if (!manifest || !existsSync(manifest)) return { checked: 0, leaked: [] };
  const states = [...new Set(readFileSync(manifest, "utf8").split("\n").filter(Boolean))];
  const deadline = Date.now() + settleMs;
  let leaked = [];
  for (;;) {
    const table = processTable();
    leaked = states.flatMap((state) => liveRelays(state, table).map((relay) => ({ state, ...relay })));
    if (leaked.length === 0 || Date.now() > deadline) break;
    pause(250);
  }
  killRelays(leaked);
  return { checked: states.length, leaked };
}

export function describeRelayLeaks(result) {
  if (result.checked === 0) return ["nothing to check: no test file isolated a fake rex"];
  if (result.leaked.length === 0) return [`no leaked fake rex relays: ${result.checked} fake rex state file(s) checked`];
  return [
    `${result.leaked.length} fake rex relay(s) outlived their test file and were killed`,
    ...result.leaked.map((r) => `  relay ${r.relay_pid} (block ${r.block_id}) from ${r.state}`),
  ];
}
