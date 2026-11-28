import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { claudeConfigDir } from "./claudeDir.js";
import { findProjectForCwd } from "./context.js";
import { db } from "./db.js";
import { loadProjectYml } from "./projectYml.js";
import { REX_RESUME_RULE_NAME } from "./rexResume.js";
import { REX_RULE_INSTALL, resumeRuleState } from "./rexResumeRule.js";
import { rexRetileSetting } from "./rexRetile.js";
import { resolveTerminal, type TerminalSource } from "./terminal.js";
import {
  describeRexServer,
  REX_SOCKET_PREFIX,
  REX_WAY_BACK,
  rexBlockAlive,
  rexClearStaleReaps,
  rexHealth,
  rexSnapshot,
  rexUnownedIn,
} from "./terminal/rex.js";

const REX_PROGRAM = "rex";
const NAMING_ON = "ON (workers may rename your session)";

export interface DoctorReport {
  check: (label: string, fn: () => string) => void;
  warn: (label: string, ...lines: string[]) => void;
  info: (label: string, ...lines: string[]) => void;
}

const countRows = (where: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE status = 'running' AND ${where}`).get() as { n: number }).n;

const REX_ROW = "(tmux_target LIKE 'block:%' OR tmux_socket LIKE 'rex:%')";

const runningRexRows = (): boolean => countRows(REX_ROW) > 0;

const runningTmuxRows = (): boolean => countRows(`NOT ${REX_ROW}`) > 0;

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch {}
  }
  return null;
}

const SESSION_START_HOOK = /\brex\b[\s\S]*\bsession-start\b/;
const NAMING_FLAG = /--(?:feature-)?session-naming(?:=|\s+)?(["']?)([^\s"']*)\1/g;

export const namingOnIn = (command: string): boolean =>
  SESSION_START_HOOK.test(command) && [...command.matchAll(NAMING_FLAG)].some((m) => m[2] !== "false");

function sessionStartCommands(file: string): string[] {
  let parsed: { hooks?: { SessionStart?: { hooks?: { command?: unknown }[] }[] } };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const groups = Array.isArray(parsed?.hooks?.SessionStart) ? parsed.hooks.SessionStart : [];
  return groups.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [])).map((h) => h?.command).filter((c): c is string => typeof c === "string");
}

export function sessionNamingOn(projectPath: string | null): string | null {
  const files = [join(claudeConfigDir(), "settings.json")];
  if (projectPath) files.push(join(projectPath, ".claude", "settings.json"), join(projectPath, ".claude", "settings.local.json"));
  return files.find((f) => sessionStartCommands(f).some(namingOnIn)) ?? null;
}

function reportBlocks(r: DoctorReport, endpoint: string): void {
  const snap = rexSnapshot(endpoint);
  if (snap === null || !snap.answered) {
    r.warn("rex blocks", "the Rex snapshot did not answer, so owned and orphaned blocks are unknown");
    return;
  }
  const rows = db
    .prepare("SELECT name, tmux_target FROM agents WHERE status = 'running' AND tmux_socket = ? AND tmux_target LIKE 'block:%' ORDER BY id")
    .all(`${REX_SOCKET_PREFIX}${endpoint}`) as { name: string; tmux_target: string }[];
  const owned = rows.filter((row) => rexBlockAlive(row.tmux_target, snap) === true);
  const gone = rows.filter((row) => rexBlockAlive(row.tmux_target, snap) === false);
  const orphans = rexUnownedIn(snap) ?? [];
  const head = `${owned.length} owned, ${gone.length} rows gone, ${orphans.length} orphan blocks`;
  const detail = [
    ...gone.map((row) => `${row.name}: ${row.tmux_target} is gone; the janitor closes its row`),
    ...orphans.map((o) => `${o.label} ${o.block} has no hive row; close it with: rex block close ${o.block}`),
    ...(snap.incomplete ? ["some Rex sessions could not be read, so the orphan count may be short"] : []),
  ];
  if (gone.length > 0 || orphans.length > 0 || snap.incomplete) r.warn("rex blocks", head, ...detail);
  else r.check("rex blocks", () => head);
}

function reportResumeRule(r: DoctorReport): void {
  const rule = resumeRuleState();
  const label = "rex resume rule";
  if (rule.state === "current") r.check(label, () => "installed");
  else if (rule.state === "unknown") r.warn(label, `unknown: ${rule.detail}`);
  else if (rule.state === "missing") {
    r.warn(label, "missing", `no "${REX_RESUME_RULE_NAME}" resume rule is in ${rule.path}, so after a Rex restart hive blocks come back as shells`, `install it with: ${REX_RULE_INSTALL}`);
  } else {
    r.warn(label, `stale: ${rule.detail}`, "it no longer matches the command hive records, so after a Rex restart hive blocks come back as shells", `update it with: ${REX_RULE_INSTALL}`);
  }
}

export function reportRex(r: DoctorReport, resolved: { terminal: string; source: TerminalSource }, projectPath: string | null): void {
  r.check("terminal", () => `${resolved.terminal} (from ${resolved.source})`);
  r.check("retile", () => {
    const retile = rexRetileSetting(projectPath ?? process.cwd());
    return `${retile.on ? "on" : "off"} (${retile.source})`;
  });
  const path = onPath(REX_PROGRAM);
  r.check("rex", () => {
    if (!path) throw new Error(`rex is not installed or not on PATH. ${REX_WAY_BACK}`);
    return path;
  });
  let reachable: string | null = null;
  if (path) {
    const health = rexHealth();
    if (health.ok) {
      reachable = health.endpoint;
      r.check("rex server", () => `reachable, ${describeRexServer(health.version, health.revision)}`);
    } else if (health.problem === "old") {
      reachable = health.endpoint ?? null;
      r.warn(
        "rex server",
        `reachable, ${describeRexServer(health.version ?? "unknown", health.revision ?? null)}`,
        `hive lead refuses to start on this server. Update Rex. ${REX_WAY_BACK}`,
      );
    } else {
      r.check("rex server", () => {
        throw new Error(`${health.message.trim()}. hive never starts a Rex server. ${REX_WAY_BACK}`);
      });
    }
    if (reachable) reportBlocks(r, reachable);
    reportResumeRule(r);
  }
  const naming = sessionNamingOn(projectPath);
  if (naming) r.warn("rex session naming hook", NAMING_ON, `set by the SessionStart hook in ${naming}; pass --feature-session-naming=false there to turn it off`);
  else r.check("rex session naming hook", () => "off");
  const cleared = rexClearStaleReaps(reachable);
  if (cleared.length > 0) {
    r.info(
      "rex reap",
      `cleared ${cleared.length} pending reap ${cleared.length === 1 ? "entry" : "entries"} (${cleared.map((a) => `agent ${a}`).join(", ")}) whose server has not answered for over 10 minutes`,
    );
  }
}

function projectHere(): { path: string } | null {
  try {
    return findProjectForCwd();
  } catch {
    return null;
  }
}

function effectiveTerminal(path: string | null): { terminal: string; source: TerminalSource } {
  try {
    return resolveTerminal(loadProjectYml(path ?? process.cwd()).config);
  } catch {
    return { terminal: "tmux", source: "default" };
  }
}

export function rexDoctorSection(r: DoctorReport): boolean {
  const path = projectHere()?.path ?? null;
  const resolved = effectiveTerminal(path);
  if (resolved.terminal === "rex" || runningRexRows()) reportRex(r, resolved, path);
  return resolved.terminal === "tmux" || runningTmuxRows();
}
