import { execFileSync, spawnSync } from "node:child_process";
import { tmux, tmuxSocketPath, tmuxWithClientPath } from "./tmux.js";

export {
  sendText,
  capturePane,
  captureRawPane,
  targetLive,
  targetLiveProbe,
  rowLive,
  rowAlive,
  rowLiveProbe,
  rowAliveProbe,
  rowOwnership,
  observeRowOwnership,
  liveTargets,
  targetAlive,
  targetPid,
  panePid,
  panePidForRecord,
  paneProcessExited,
  paneInCopyMode,
  cancelCopyMode,
  paneCurrentCommand,
  paneTitle,
  inputBoxSnapshot,
  inputBoxState,
  claudeTrailerView,
  paneChoiceCheck,
  paneAwaitingChoice,
  codexInputBoxState,
  codexTrailerView,
  codexPaneChoiceCheck,
  pollPaneReadiness,
  waitForPaneInput,
  waitForPaneEstablished,
  setRemainOnExit,
  captureFinalScreen,
  foreignSocket,
  adoptableWindow,
  appendGlobalHook,
  applyLayout,
  claimInitialWindow,
  codexPaneHasInputBox,
  configureHiveWindow,
  createWindow,
  crossServerRefusal,
  ensureAttached,
  ensureSession,
  findProcessesWindow,
  findProjectWindow,
  globalHooks,
  listOwnedWindows,
  makeProcessesWindow,
  orphanScratchServers,
  paneHasInputBox,
  paneIsAloneInWindow,
  paneVisibility,
  paneWindow,
  projectWindows,
  replaceGlobalHooks,
  resolveAttachTarget,
  resolveInTmuxTarget,
  setPaneTitle,
  untrustedTmuxServer,
  windowLayout,
  windowOwner,
} from "./tmux.js";

export interface SplitArgs {
  argv: string[];
  clientPath?: string | null;
}

export interface RespawnArgs {
  target: string;
  cwd: string;
  env: string[];
  command: string;
}

export const callerPane = (): string => process.env.TMUX_PANE ?? "";

export const callerSocket = (): string => tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);

export const callerTmuxTmpDir = (): string | undefined => process.env.TMUX_TMPDIR;

export const insideTerminal = (): boolean => !!process.env.TMUX;

export function killPane(target: string): void {
  tmux("kill-pane", "-t", target);
}

export function killWindow(target: string): void {
  tmux("kill-window", "-t", target);
}

export function splitPane({ argv, clientPath }: SplitArgs): { target: string; pid: string } {
  const out = clientPath === undefined ? tmux(...argv) : tmuxWithClientPath(clientPath, ...argv);
  const [target, pid = ""] = out.split("\t");
  return { target, pid };
}

export function respawnPane({ target, cwd, env, command }: RespawnArgs): { target: string } {
  tmux("respawn-pane", "-k", "-t", target, "-c", cwd, ...env, command);
  return { target };
}

export function attachInteractive(argv: string[]): number {
  return spawnSync("tmux", argv, { stdio: "inherit" }).status ?? 0;
}

export const createBareWindow = (argv: string[]): string => tmux(...argv);

export const renameWindow = (window: string, name: string): string => tmux("rename-window", "-t", window, name);

export const listPaneIds = (target: string): string => tmux("list-panes", "-t", target, "-F", "#{pane_id}");

export const paneWindowStamps = (target: string): string =>
  tmux("list-panes", "-t", target, "-F", "#{window_name}\t#{@hive-project-id}\t#{@hive-owned}");

export function joinPane(source: string, destination: string, horizontal = false): void {
  tmux("join-pane", ...(horizontal ? ["-h"] : []), "-d", "-s", source, "-t", destination);
}

export const breakPane = (source: string, windowName: string): string =>
  tmux("break-pane", "-d", "-P", "-F", "#{session_name}:#{window_id}", "-s", source, "-n", windowName);

export function swapPane(source: string, target: string): void {
  tmux("swap-pane", "-s", source, "-t", target);
}

export function sendKeys(target: string, keys: string[]): void {
  tmux("send-keys", "-t", target, "--", ...keys);
}

export function interruptPane(target: string): void {
  tmux("send-keys", "-t", target, "C-c");
}

export const terminalVersion = (): string => execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim();

export const serverEnvironment = (name: string): string => tmux("show-environment", "-g", name);

export const listSessionNames = (): string => tmux("ls", "-F", "#{session_name}");

export const sessionClients = (name: string): string => tmux("list-clients", "-t", `=${name}`);

export const listWindowOwnership = (): string =>
  tmux("list-windows", "-a", "-F", "#{session_name}:#{window_id}\t#{@hive-owned}");

export const showOption = (scope: "-p" | "-w", target: string, optionName: string): string =>
  tmux("show-options", scope, "-A", "-v", "-t", target, optionName);

export const isRexTarget = (target: string): boolean => target.startsWith("block:");

export const isRexSocket = (socket: string): boolean => socket.startsWith("rex:");

export const rexServerOf = (socket: string): string => socket.replace(/^rex:/, "");
