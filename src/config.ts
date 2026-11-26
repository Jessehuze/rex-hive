import { readGlobalConfig, resolveAttachSetting, writeGlobalConfigKey } from "./globalConfig.js";

export {
  ATTACH_MODES,
  AUTO_ATTACH_MODES,
  isAttachMode,
  isAutoAttach,
  isTerminal,
  migrateLegacyConfig,
  TERMINALS,
  type AttachMode,
  type AutoAttach,
  type ConfigSource,
  type Terminal,
} from "./globalConfig.js";

import type { AttachMode, AutoAttach, ConfigSource, Terminal } from "./globalConfig.js";

export function resolvedAttachMode(): { mode: AttachMode; source: ConfigSource } {
  const global = readGlobalConfig();
  return resolveAttachSetting("attach", global.root, global.legacy, global.warnings) as {
    mode: AttachMode; source: ConfigSource;
  };
}

export function attachMode(): AttachMode {
  return resolvedAttachMode().mode;
}

export function resolvedAutoAttach(): { value: AutoAttach; source: ConfigSource } {
  const global = readGlobalConfig();
  return resolveAttachSetting("autoAttach", global.root, global.legacy, global.warnings) as {
    value: AutoAttach; source: ConfigSource;
  };
}

export function setAttachMode(mode: AttachMode): void {
  writeGlobalConfigKey("attach", mode);
}

export function setAutoAttach(value: AutoAttach): void {
  writeGlobalConfigKey("autoAttach", value);
}

export function setTerminal(value: Terminal): void {
  writeGlobalConfigKey("terminal", value);
}
