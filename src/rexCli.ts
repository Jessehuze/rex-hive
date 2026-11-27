import { execFileSync } from "node:child_process";

export const REX_TIMEOUT = "10s";

const KILL_MARGIN_MS = 2000;
const REX_MAX_BUFFER = 128 * 1024 * 1024;
const DURATION = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/;
const NO_SERVER_EXIT = 4;
const NO_SERVER = /no Rex server is running at /;
const MAX_TIMEOUT_MS = 60_000;
const STDIN_PARAMS_BYTES = 64 * 1024;
const FAILURE_CACHE_MS = 30_000;
const API_CODE = /\b(session_not_found|method_not_found|not_found|bad_request|conflict|unauthorized|forbidden|internal)\b/;

export class RexError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "RexError";
  }
}

export class RexTimeoutError extends RexError {
  constructor(
    message: string,
    stderr: string,
    readonly timeoutMs: number,
  ) {
    super(message, "timeout", stderr);
    this.name = "RexTimeoutError";
  }
}

export class RexUnavailableError extends RexError {
  constructor(message: string, code: string, stderr: string) {
    super(message, code, stderr);
    this.name = "RexUnavailableError";
  }
}

export function durationMs(text: string): number {
  let total = 0;
  for (const [, n, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    total += Number(n) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit as "ms" | "s" | "m" | "h"];
  }
  return total;
}

export function rexTimeout(): string {
  const raw = process.env.HIVE_REX_TIMEOUT;
  if (!raw || !DURATION.test(raw) || !(durationMs(raw) > 0)) return REX_TIMEOUT;
  return `${Math.min(Math.ceil(durationMs(raw)), MAX_TIMEOUT_MS)}ms`;
}

interface ExecFailure {
  code?: string;
  signal?: string | null;
  status?: number | null;
  stderr?: string | Buffer;
}

function classify(err: unknown, verb: string, killMs: number, timeoutMs: number, elapsedMs: number): RexError {
  const e = err as ExecFailure;
  const stderr = String(e.stderr ?? "").trim();
  if (e.code === "ENOENT") return new RexUnavailableError("rex is not installed or not on PATH", "ENOENT", stderr);
  if (e.code === "ETIMEDOUT") return new RexTimeoutError(`rex ${verb} did not finish within ${killMs}ms and was killed`, stderr, killMs);
  if (e.code === "ENOBUFS") return new RexError(`rex ${verb} printed more than ${REX_MAX_BUFFER} bytes`, "ENOBUFS", stderr);
  if (e.signal) return new RexError(`rex ${verb} was killed by ${e.signal}`, `signal ${e.signal}`, stderr);
  if (e.status === NO_SERVER_EXIT || NO_SERVER.test(stderr)) return new RexUnavailableError(`the Rex server is unreachable: ${stderr}`, "unreachable", stderr);
  if (elapsedMs >= timeoutMs) return new RexTimeoutError(`rex ${verb} failed after its ${timeoutMs}ms timeout: ${stderr}`, stderr, timeoutMs);
  const code = API_CODE.exec(stderr)?.[1] ?? `exit ${e.status ?? "?"}`;
  return new RexError(`rex ${verb} failed: ${stderr || code}`, code, stderr);
}

function rexRun(server: string | null, args: string[], input?: string, failedOutput?: { stdout: string; status: number | null }): string {
  if (process.env.NODE_TEST_CONTEXT && !process.env.FAKE_REX_STATE) {
    throw new RexError("refusing to run rex under the test runner without isolateRex()", "test-isolation", "");
  }
  const timeout = rexTimeout();
  const argv = ["--autostart=false", "--timeout", timeout, ...(server ? ["-S", server] : []), ...args];
  const timeoutMs = durationMs(timeout);
  const killMs = timeoutMs + KILL_MARGIN_MS;
  const started = Date.now();
  try {
    return execFileSync("rex", argv, {
      encoding: "utf8",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      input,
      maxBuffer: REX_MAX_BUFFER,
      timeout: killMs,
      killSignal: "SIGKILL",
    });
  } catch (err) {
    const { status, stdout } = err as ExecFailure & { stdout?: string };
    if (failedOutput && status === 1 && stdout) {
      failedOutput.status = 1;
      return (failedOutput.stdout = stdout);
    }
    throw classify(err, args[0] ?? "", killMs, timeoutMs, Date.now() - started);
  }
}

function parseJson<T>(stdout: string, verb: string): T {
  const text = stdout.trim();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new RexError(`rex ${verb} printed output that is not JSON`, "bad_output", "");
  }
}

export function rexApi<T>(server: string, method: string, params: object): T {
  const json = JSON.stringify(params);
  const viaStdin = Buffer.byteLength(json) > STDIN_PARAMS_BYTES;
  return parseJson<T>(rexRun(server, ["api", "call", method, viaStdin ? "-" : json], viaStdin ? json : undefined), method);
}

export function rexKey(server: string, block: string, key: string, session?: string): void {
  rexRun(server, ["send-key", ...(session ? ["-s", session] : []), "-b", block, key]);
}

export function rexLua<T>(server: string, script: string, args?: object): T {
  return parseJson<T>(rexRun(server, ["do", "-e", script, "--json", ...(args ? ["--args", JSON.stringify(args)] : [])]), "do");
}

function endpointOf(who: unknown): string | null {
  const endpoint = (who as { endpoint?: unknown } | null)?.endpoint;
  return typeof endpoint === "string" && endpoint ? endpoint : null;
}

export const rexCallerBlock = (): string | null => (process.env.REX_BLOCK && !process.env.TMUX ? process.env.REX_BLOCK : null);

let cachedServer: string | null = null;
let failedAt: number | null = null;

export function defaultRexServer(): string | null {
  const fromEnv = process.env.REX_SERVER;
  if (fromEnv) return fromEnv;
  if (cachedServer) return cachedServer;
  if (failedAt !== null && Date.now() - failedAt < FAILURE_CACHE_MS) return null;
  try {
    cachedServer = endpointOf(JSON.parse(rexRun(null, ["whoami", "--json"])));
  } catch {
    cachedServer = null;
  }
  failedAt = cachedServer ? null : Date.now();
  return cachedServer;
}

export interface RexWhoami {
  endpoint: string | null;
  version: string;
  revision: number | null;
}

export function rexWhoami(): RexWhoami {
  const who = parseJson<{ rex_version?: unknown; api_revision?: unknown }>(rexRun(null, ["whoami", "--json"]), "whoami");
  const endpoint = endpointOf(who);
  if (endpoint) {
    cachedServer = endpoint;
    failedAt = null;
  }
  return {
    endpoint,
    version: typeof who.rex_version === "string" ? who.rex_version : "unknown",
    revision: typeof who.api_revision === "number" ? who.api_revision : null,
  };
}

export interface RexConfigCheck {
  status: number;
  report: { path?: unknown; exists?: unknown; resume_rules?: unknown; diagnostics?: unknown };
}

export function rexConfigCheck(path?: string): RexConfigCheck {
  const failed = { stdout: "", status: null as number | null };
  const stdout = rexRun(null, ["config", "check", ...(path ? [path] : []), "--json"], undefined, failed);
  const report = parseJson<RexConfigCheck["report"]>(stdout, "config check");
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new RexError("rex config check printed JSON that is not an object", "bad_output", "");
  return { status: failed.status ?? 0, report };
}

export const rexConfigReload = (): string => rexRun(null, ["config", "reload"]);

export const SNAPSHOT_SCRIPT = `-- hive:snapshot v1
local wanted = {}
for _, id in ipairs((rex.args or {}).blocks or {}) do wanted[id] = true end
local listed, err = rex.call("session.list", {})
if not listed then error("session.list failed: " .. tostring(err)) end
local blocks = {}
local incomplete = false
for _, s in ipairs(listed.sessions or {}) do
  local _, attach_err = rex.session.attach{ session_id = s.session_id }
  local held = nil
  if attach_err == nil then held = rex.call("session.list_blocks", { session_id = s.session_id }) end
  if not held then
    incomplete = true
  else
    for _, b in ipairs(held.blocks or {}) do
      local entry = {
        session_id = s.session_id,
        session_label = s.label or "",
        window_id = b.window_id or "",
        label = b.label or "",
        placement = b.placement or "",
        probed = false,
      }
      if wanted[b.block_id] then
        local function method(name)
          return rex.call("block.method", { session_id = s.session_id, block_id = b.block_id, method = name, args = {} })
        end
        entry.probed = true
        entry.process = method("process")
        entry.program_status = method("program_status")
      end
      blocks[b.block_id] = entry
    end
  end
end
return { version = 1, incomplete = incomplete, blocks = blocks }
`;
