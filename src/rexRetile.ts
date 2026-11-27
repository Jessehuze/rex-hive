import { db } from "./db.js";
import { loadProjectYml, type ConfigSource } from "./projectYml.js";
import { DEFAULT_LAYOUT, type WindowLayout } from "./tmux.js";
import { rexHideBlock, rexProjectLead, rexRetileTab, rexShowBlock, rexTiledInTab, type RexShownAs } from "./terminal/rex.js";

type Anchor = { tmux_target: string; tmux_socket: string };

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
  try {
    return run() != null;
  } catch {
    return false;
  }
}

export function rexRetileAfterPlace(
  spec: { projectPath: string; layout?: WindowLayout; placement: string; hidden: boolean },
  anchor: Anchor,
  target: string,
): boolean {
  if (spec.placement !== "split" || spec.hidden) return false;
  return attempt(() => {
    const { on, layout } = settings(spec.projectPath);
    return on ? rexRetileTab(anchor, spec.layout ?? layout, [target]) : null;
  });
}

function retileProject(projectId: number): void {
  attempt(() => {
    const path = projectPath(projectId);
    const lead = rexProjectLead(projectId);
    if (!path || !lead) return null;
    const { on, layout } = settings(path);
    return on ? rexRetileTab(lead, layout) : null;
  });
}

export function rexShowRetiled(projectId: number, name: string, target: string, placement: RexShownAs, windowLabel: string): string {
  const line = rexShowBlock(projectId, name, target, placement, windowLabel);
  if (line.endsWith(": shown")) retileProject(projectId);
  return line;
}

export function rexHideRetiled(projectId: number, name: string, target: string, remember = false): string {
  const line = rexHideBlock(projectId, name, target, remember);
  if (line.endsWith(": hidden")) retileProject(projectId);
  return line;
}

function closingInLeadSplit(target: string): number | null {
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

export function rexCloseRetiled<T>(target: string, close: () => T, claim: (run: () => void) => void): T {
  const projectId = closingInLeadSplit(target);
  const result = close();
  if (projectId !== null && !db.inTransaction) attempt(() => claim(() => retileProject(projectId)));
  return result;
}
