import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { db, dataDir } from "./db.js";
import { isDefaultStore } from "./dataDir.js";
import type { AgentRow } from "./agentRecords.js";
import { getProject } from "./context.js";
import { workerResumeLaunch } from "./agentResume.js";
import { codexHomeDir } from "./codexHome.js";
import { harnessFor } from "./harnesses.js";
import { agentIdentityEnv, LEAD_KIND } from "./spawn.js";
import { leadIdentityEnv } from "./leadLaunch.js";
import { FIRST_MESSAGE_SHA_ENV } from "./firstMessage.js";
import { loadProjectYml } from "./projectYml.js";
import { shellQuote } from "./tmux.js";
import { ACTIVE_TIMER_WHERE, socketAwaitingWhere } from "./wakeSql.js";
import { commandArgv, hiveInvocation, REX_SHELL, REX_SOCKET_PREFIX, rexBlockCommand, rexLaunchArgv } from "./terminal/rex.js";

export const REX_RESUME_VERB = "__rex-resume";
export const REX_RESUME_PID_ENV = "HIVE_REX_RESUME_PID";
export const REX_RESUME_SCRIPT = `c=$(${REX_RESUME_PID_ENV}=$$ "$@" 3>&1 1>&2) && [ -n "$c" ] || c='exec "\${SHELL:-/bin/sh}"'; eval "$c"`;
export const REX_RESUME_RULE_NAME = "hive";
export const OSC7577_TOKEN_ENV = "OSC7577_TOKEN";
export const OSC7577_MAX_BYTES = 2048;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22,64}$/;
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/;

export class RexResumeRefusal extends Error {
  constructor(readonly who: string, readonly reason: string) {
    super(`hive: not resuming ${who}: ${reason}`);
    this.name = "RexResumeRefusal";
  }
}

function refuse(who: string, reason: string): never {
  throw new RexResumeRefusal(who, reason);
}

const dataDirArgs = (): string[] => (isDefaultStore(dataDir) ? [] : ["--data-dir", dataDir]);

export function resumeRecordArgv(agentId: number): string[] {
  return [REX_SHELL, "-c", REX_RESUME_SCRIPT, "hive", ...hiveInvocation(), REX_RESUME_VERB, String(agentId), ...dataDirArgs()];
}

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

export function osc7577Report(pairs: string, token: string): string {
  const mac = createHash("sha256").update(`${pairs}:${token}`).digest("hex");
  return `\x1b]7577;${pairs}:mac=${mac}\x1b\\`;
}

export function rexLaunchReport(agentId: number, pid: string, token: string | undefined, nowMs = Date.now()): string | null {
  if (!token || !TOKEN_SHAPE.test(token) || !/^[1-9]\d*$/.test(pid)) return null;
  const head = `pid=${pid}:time=${Math.floor(nowMs / 1000)}`;
  const argv = resumeRecordArgv(agentId);
  const report = osc7577Report(`${head}:argv=${argv.map(b64).join(",")}`, token);
  if (argv.some((a) => CONTROL_CHAR.test(a)) || Buffer.byteLength(report) > OSC7577_MAX_BYTES) {
    return osc7577Report(`${head}:clear=1`, token);
  }
  return report;
}

const luaString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function rexResumeTrustRule(): string {
  const words = resumeRecordArgv(0).map(luaString);
  words[words.length - 1 - dataDirArgs().length] = "rex.match.id";
  return [
    `rex.set("resume.trust.${REX_RESUME_RULE_NAME}", {`,
    `  command = { ${words.join(", ")} },`,
    "})",
  ].join("\n");
}

function processAlive(pid: string): boolean {
  if (!/^\d+$/.test(pid)) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function psField(pid: string | number, field: string): string | null {
  try {
    return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

// dash execs the substitution's command, so node's parent is $$; bash forks a subshell first.
function isResumingShell(pid: string): boolean {
  return Number(pid) === process.ppid || psField(process.ppid, "ppid") === pid;
}

// Fail-safe: unless ps shows a process that names none of the row's program, it is the harness.
function recordedProcessRunning(row: AgentRow): boolean {
  if (!processAlive(row.pane_pid)) return false;
  const words = commandArgv(row.command);
  const program = words[0] === REX_SHELL ? "" : basename(words[0] ?? "");
  const args = psField(row.pane_pid, "args");
  return !program || !args || args.split(/\s+/).some((word) => basename(word).includes(program));
}

interface ResumeLaunch {
  commandString: string;
  env: Record<string, string>;
  cwd: string;
}

function workerLaunch(row: AgentRow, projectPath: string, projectId: number): ResumeLaunch {
  const harness = harnessFor(row.command);
  if (!harness.supportsResume) refuse(row.name, `its harness (${harness.name}) cannot resume a session`);
  if (!row.session_id) refuse(row.name, "it has no recorded session id");
  if (harness.name === "codex" && (!row.codex_home || !existsSync(codexHomeDir(row.codex_home)))) refuse(row.name, "its Codex home is missing");
  if (!row.cwd || !existsSync(row.cwd)) refuse(row.name, `its working directory ${row.cwd || "(empty)"} is gone`);
  const clash = db
    .prepare("SELECT id FROM agents WHERE project_id = ? AND status = 'running' AND id != ? AND lower(name) = lower(?)")
    .get(projectId, row.id, row.name);
  if (clash) refuse(row.name, "another running agent has its name");
  const project = getProject(projectId)!;
  const { commandString, env } = workerResumeLaunch(project, row, harness, loadProjectYml(projectPath).config);
  return { commandString, env: { ...env, ...agentIdentityEnv(row.actor_id, row.name, projectPath) }, cwd: row.cwd };
}

function leadLaunch(row: AgentRow, projectPath: string): ResumeLaunch {
  const harness = harnessFor(row.command);
  if (!harness.supportsResume) refuse(row.name, `its harness (${harness.name}) cannot resume a session`);
  if (!existsSync(projectPath)) refuse(row.name, `its working directory ${projectPath} is gone`);
  const turn = db.prepare("SELECT session_id FROM lead_turn_state WHERE agent_id = ? AND pane_pid = ?").get(row.id, row.pane_pid) as
    | { session_id: string }
    | undefined;
  if (!turn?.session_id) refuse(row.name, "it has no recorded session id for its last process");
  const codex = harness.name === "codex";
  if (codex && (!row.codex_home || !existsSync(codexHomeDir(row.codex_home)))) refuse(row.name, "its Codex home is missing");
  const resumeArgs = codex ? ["resume", turn!.session_id] : ["--resume", turn!.session_id];
  return {
    commandString: `${row.command} ${resumeArgs.map(shellQuote).join(" ")}`,
    env: { ...leadIdentityEnv(row.actor_id), [FIRST_MESSAGE_SHA_ENV]: "", ...(codex ? { CODEX_HOME: codexHomeDir(row.codex_home) } : {}) },
    cwd: projectPath,
  };
}

function recordResumedPid(row: AgentRow, pid: string, command: string, pending: boolean): boolean {
  return db.transaction(() => {
    if (row.kind === LEAD_KIND) {
      const changed = db
        .prepare(
          "UPDATE agents SET pane_pid = ?, pane_started_at = strftime('%Y-%m-%d %H:%M:%f', 'now') " +
            "WHERE id = ? AND kind = ? AND status = 'running' AND tmux_target = ? AND tmux_socket = ? AND pane_pid = ?",
        )
        .run(pid, row.id, LEAD_KIND, row.tmux_target, row.tmux_socket, row.pane_pid).changes > 0;
      if (changed) {
        db.prepare(
          `UPDATE wakes SET deliver_pane = ?, held_at = NULL, held_reason = NULL
           WHERE ((${ACTIVE_TIMER_WHERE}) OR (${socketAwaitingWhere()})) AND deliver_actor = ?`,
        ).run(row.tmux_target, row.actor_id);
      }
      return changed;
    }
    return db
      .prepare(
        "UPDATE agents SET status = 'running', closed_at = NULL, recovery_state = '', pane_pid = ?, command = ?, " +
          "pane_started_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), resumed_at = datetime('now'), " +
          "agent_state = 'unknown', state_changed_at = NULL " +
          "WHERE id = ? AND tmux_target = ? AND tmux_socket = ? AND pane_pid = ? AND " +
          (pending ? "status = 'closed' AND recovery_state = 'pending' AND parked_at = ''" : "status = 'running'"),
      )
      .run(pid, command, row.id, row.tmux_target, row.tmux_socket, row.pane_pid).changes > 0;
  }).immediate();
}

export function rexResumeLine(agentId: number, pid: string | undefined, block: string | undefined): string {
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
  if (!row) return refuse(`agent ${agentId}`, "the store has no such agent");
  if (!block) refuse(row.name, "REX_BLOCK is not set, so this is not a restored Rex block");
  if (row.tmux_target !== block) refuse(row.name, `its row records block ${row.tmux_target || "(none)"}, not this block ${block}`);
  if (!row.tmux_socket.startsWith(REX_SOCKET_PREFIX)) refuse(row.name, "its row is not on a Rex server");
  if (!pid || !/^[1-9]\d*$/.test(pid)) refuse(row.name, "the restored process id is unknown");
  if (!isResumingShell(pid!)) refuse(row.name, `the restored process id ${pid} is not the shell running this resume`);
  const pending = row.kind !== LEAD_KIND && row.status === "closed" && row.recovery_state === "pending" && !row.parked_at;
  if (row.status !== "running" && !pending) refuse(row.name, `its row is ${row.status}, not running or waiting for crash recovery`);
  if (row.kind !== LEAD_KIND && row.kind !== "agent") refuse(row.name, "only workers and leads are resumed");
  if (row.pane_pid === pid || recordedProcessRunning(row)) refuse(row.name, `its recorded process ${row.pane_pid} is still running`);
  const project = getProject(row.project_id);
  if (!project) return refuse(row.name, `project ${row.project_id} is no longer registered`);
  const launch = row.kind === LEAD_KIND ? leadLaunch(row, project.path) : workerLaunch(row, project.path, project.id);
  if (!recordResumedPid(row, pid!, launch.commandString, pending)) refuse(row.name, "its row changed while it was being resumed");
  const words = rexBlockCommand(launch.env, rexLaunchArgv(row.id, commandArgv(launch.commandString)));
  return `cd -- ${shellQuote(launch.cwd)} && exec ${words.map(shellQuote).join(" ")}`;
}
