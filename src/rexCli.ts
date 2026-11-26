import { execFileSync } from "node:child_process";

export const REX_TIMEOUT = "10s";

const KILL_MARGIN_MS = 2000;
const REX_MAX_BUFFER = 128 * 1024 * 1024;
const DURATION = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/;
const NO_SERVER_EXIT = 4;
const NO_SERVER = /no Rex server is running at /;
const REX_TIMED_OUT = /deadline exceeded|timed out|i\/o timeout/i;
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
  return raw && DURATION.test(raw) && durationMs(raw) > 0 ? raw : REX_TIMEOUT;
}

interface ExecFailure {
  code?: string;
  signal?: string | null;
  status?: number | null;
  stderr?: string | Buffer;
}

function classify(err: unknown, verb: string, killMs: number): RexError {
  const e = err as ExecFailure;
  const stderr = String(e.stderr ?? "").trim();
  if (e.code === "ENOENT") return new RexUnavailableError("rex is not installed or not on PATH", "ENOENT", stderr);
  if (e.code === "ETIMEDOUT" || e.signal) {
    return new RexTimeoutError(`rex ${verb} did not finish within ${killMs}ms and was killed`, stderr, killMs);
  }
  if (e.status === NO_SERVER_EXIT || NO_SERVER.test(stderr)) return new RexUnavailableError(`the Rex server is unreachable: ${stderr}`, "unreachable", stderr);
  if (REX_TIMED_OUT.test(stderr)) return new RexTimeoutError(`rex ${verb} timed out: ${stderr}`, stderr, durationMs(rexTimeout()));
  const code = API_CODE.exec(stderr)?.[1] ?? `exit ${e.status ?? "?"}`;
  return new RexError(`rex ${verb} failed: ${stderr || code}`, code, stderr);
}

function rexRun(server: string | null, args: string[]): string {
  const timeout = rexTimeout();
  const argv = ["--autostart=false", "--timeout", timeout, ...(server ? ["-S", server] : []), ...args];
  const killMs = durationMs(timeout) + KILL_MARGIN_MS;
  try {
    return execFileSync("rex", argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: REX_MAX_BUFFER,
      timeout: killMs,
      killSignal: "SIGKILL",
    });
  } catch (err) {
    throw classify(err, args[0] ?? "", killMs);
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
  return parseJson<T>(rexRun(server, ["api", "call", method, JSON.stringify(params)]), method);
}

export function rexKey(server: string, block: string, key: string): void {
  rexRun(server, ["send-key", "-b", block, key]);
}

export function rexLua<T>(server: string, script: string): T {
  return parseJson<T>(rexRun(server, ["do", "-e", script, "--json"]), "do");
}

function endpointOf(who: unknown): string | null {
  const endpoint = (who as { endpoint?: unknown } | null)?.endpoint;
  return typeof endpoint === "string" && endpoint ? endpoint : null;
}

let cachedServer: string | null = null;

export function defaultRexServer(): string | null {
  const fromEnv = process.env.REX_SERVER;
  if (fromEnv) return fromEnv;
  if (cachedServer) return cachedServer;
  try {
    cachedServer = endpointOf(JSON.parse(rexRun(null, ["whoami", "--json"])));
  } catch {
    return null;
  }
  return cachedServer;
}

export const SNAPSHOT_SCRIPT = `-- hive:snapshot v1
local function try(method, args)
  local ok, result = pcall(rex.call, method, args)
  if ok then return result end
  return nil
end
local out = { version = 1, sessions = {}, blocks = {} }
for _, s in ipairs((try("session.list", {}) or {}).sessions or {}) do
  local view = try("session.view", { session_id = s.session_id }) or {}
  local windows = {}
  for _, w in ipairs(view.windows or {}) do
    local ids = {}
    for _, layer in ipairs(w.layers or {}) do
      for _, b in ipairs(layer.blocks or {}) do table.insert(ids, b.block_id) end
    end
    table.insert(windows, { window_id = w.window_id, label = w.label, block_ids = ids })
  end
  table.insert(out.sessions, { session_id = s.session_id, label = s.label, windows = windows })
  for _, b in ipairs((try("session.list_blocks", { session_id = s.session_id }) or {}).blocks or {}) do
    local function method(name)
      return try("block.method", { session_id = s.session_id, block_id = b.block_id, method = name })
    end
    table.insert(out.blocks, {
      block_id = b.block_id,
      session_id = s.session_id,
      window_id = b.window_id,
      label = b.label,
      placement = b.placement,
      process = method("process"),
      program_status = method("program_status"),
    })
  end
end
return out
`;
