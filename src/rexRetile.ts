import { db } from "./db.js";
import { loadProjectYml, type ConfigSource } from "./projectYml.js";
import { DEFAULT_LAYOUT, type WindowLayout } from "./tmux.js";
import { rexProjectLead, rexRetileTab, rexTiledInTab } from "./terminal/rex.js";

export function rexRetileSetting(projectPath: string): { on: boolean; source: ConfigSource } {
  const loaded = loadProjectYml(projectPath);
  return { on: loaded.config?.retile !== false, source: loaded.sources.retile ?? "built-in" };
}

function settings(projectPath: string): { on: boolean; layout: WindowLayout } {
  const { config } = loadProjectYml(projectPath);
  return { on: config?.retile !== false, layout: config?.layout ?? DEFAULT_LAYOUT };
}

const projectPath = (projectId: number): string | null =>
  (db.prepare("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string } | undefined)?.path ?? null;

function attempt(run: () => unknown): boolean {
  if (db.inTransaction) return false;
  try {
    return run() != null;
  } catch {
    return false;
  }
}

function retileProject(projectId: number, layoutOverride?: WindowLayout, extra: string[] = []): unknown {
  const path = projectPath(projectId);
  const lead = rexProjectLead(projectId);
  if (!path || !lead) return null;
  const { on, layout } = settings(path);
  return on ? rexRetileTab(lead, layoutOverride ?? layout, extra) : null;
}

export function rexRetileAfterPlace(
  spec: { projectId: number; layout?: WindowLayout; placement: string; hidden: boolean },
  target: string,
): boolean {
  if (spec.placement !== "split" || spec.hidden) return false;
  return attempt(() => retileProject(spec.projectId, spec.layout, [target]));
}

const pending = new Set<number>();

export function rexRetileVisibility(projectId: number, line: string, now = true): string {
  if (!line.endsWith(": shown") && !line.endsWith(": hidden")) return line;
  if (now) attempt(() => retileProject(projectId));
  else pending.add(projectId);
  return line;
}

export function rexRetilePending(): void {
  for (const projectId of [...pending]) {
    pending.delete(projectId);
    attempt(() => retileProject(projectId));
  }
}

export function rexRetileProbe(target: string): number | null {
  if (!target.startsWith("block:")) return null;
  try {
    const row = db.prepare("SELECT project_id FROM agents WHERE tmux_target = ? AND status = 'running' AND kind != 'lead' ORDER BY id DESC LIMIT 1")
      .get(target) as { project_id: number } | undefined;
    const path = row ? projectPath(row.project_id) : null;
    const lead = row ? rexProjectLead(row.project_id) : null;
    return row && path && lead && settings(path).on && rexTiledInTab(lead, target) ? row.project_id : null;
  } catch {
    return null;
  }
}

export function rexRetileClosed(projectId: number | null): void {
  if (projectId !== null) attempt(() => retileProject(projectId));
}

export function rexCloseRetiled<T>(target: string, close: () => T): T {
  const projectId = rexRetileProbe(target);
  const result = close();
  rexRetileClosed(projectId);
  return result;
}
