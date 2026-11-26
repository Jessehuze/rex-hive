import { findProjectForCwd } from "./context.js";
import { db } from "./db.js";
import { loadProjectYml } from "./projectYml.js";
import { registerRexInUse, resolveTerminal } from "./terminal.js";
import { REX_IN_USE_KEY, registerRexStore } from "./terminal/rex.js";

export { REX_IN_USE_KEY };

export function rexInUse(): boolean {
  const flagged = db
    .prepare("SELECT 1 FROM kv WHERE key = ? AND (expires_at IS NULL OR expires_at >= datetime('now')) LIMIT 1")
    .get(REX_IN_USE_KEY);
  if (flagged) return true;
  const project = findProjectForCwd();
  const config = project ? loadProjectYml(project.path).config : null;
  return resolveTerminal({ terminal: config?.terminal ?? null }).terminal === "rex";
}

registerRexInUse(rexInUse);
registerRexStore(db);
