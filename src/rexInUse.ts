import { findProjectForCwd } from "./context.js";
import { db } from "./db.js";
import { loadProjectYml } from "./projectYml.js";
import { registerRexInUse, resolveTerminal } from "./terminal.js";
import { REX_IN_USE_KEY, registerRexStore } from "./terminal/rex.js";

export { REX_IN_USE_KEY };

const guarded = <T>(read: () => T, failed: T): T => {
  try {
    return read();
  } catch {
    return failed; // an unmigrated store (hive --help on a fresh data dir) has no tables yet
  }
};

export function rexInUse(): boolean {
  const flagged = guarded(
    () => db.prepare("SELECT 1 FROM kv WHERE key = ? AND (expires_at IS NULL OR expires_at >= datetime('now')) LIMIT 1").get(REX_IN_USE_KEY),
    undefined,
  );
  if (flagged) return true;
  const project = guarded(() => findProjectForCwd(), null);
  const config = project ? loadProjectYml(project.path).config : null;
  return resolveTerminal({ terminal: config?.terminal ?? null }).terminal === "rex";
}

registerRexInUse(rexInUse);
registerRexStore(db);
