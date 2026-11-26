import { execFileSync, spawnSync } from "node:child_process";
import { isTerminal, readGlobalConfig, type Terminal } from "./globalConfig.js";
import { defaultRexServer, rexCallerBlock } from "./rexCli.js";
import {
  rexBlockAlive,
  rexCapture,
  rexClose,
  commandArgv,
  envFromFlags,
  rexForgetShownAs,
  rexOwnership,
  rexRespawn,
  rexProbe,
  rexReapExited,
  rexReapPending,
  rexRowProbe,
  rexSendKey,
  rexSendKeys,
  serverForTarget,
  rexSendText,
  rexSnapshot,
  rexTitle,
  type RexSnapshot,
} from "./terminal/rex.js";
import {
  cancelCopyMode as tmuxCancelCopyMode,
  captureFinalScreen as tmuxCaptureFinalScreen,
  capturePane as tmuxCapturePane,
  captureRawPane as tmuxCaptureRawPane,
  claudeTrailerView as tmuxClaudeTrailerView,
  claudeTrailerViewFromRaw,
  codexInputBoxState as tmuxCodexInputBoxState,
  codexInputBoxStateFromRaw,
  codexPaneChoiceCheck as tmuxCodexPaneChoiceCheck,
  codexPaneChoiceCheckFromRaw,
  codexPaneHasInputBox as tmuxCodexPaneHasInputBox,
  codexTrailerView as tmuxCodexTrailerView,
  codexTrailerViewFromRaw,
  findCodexPromptBox,
  findInputBox,
  foreignSocket as tmuxForeignSocket,
  inputBoxSnapshot as tmuxInputBoxSnapshot,
  inputBoxSnapshotFromRaw,
  liveTargets as tmuxLiveTargets,
  observeRowOwnership as tmuxObserveRowOwnership,
  paneAwaitingChoice as tmuxPaneAwaitingChoice,
  paneChoiceCheck as tmuxPaneChoiceCheck,
  paneChoiceCheckFromRaw,
  paneCurrentCommand as tmuxPaneCurrentCommand,
  paneHasInputBox as tmuxPaneHasInputBox,
  paneInCopyMode as tmuxPaneInCopyMode,
  panePid as tmuxPanePid,
  panePidForRecord as tmuxPanePidForRecord,
  paneProcessExited as tmuxPaneProcessExited,
  paneTitle as tmuxPaneTitle,
  pollPaneReadiness as tmuxPollPaneReadiness,
  rowAlive as tmuxRowAlive,
  rowAliveProbe as tmuxRowAliveProbe,
  rowLive as tmuxRowLive,
  rowLiveProbe as tmuxRowLiveProbe,
  rowOwnership as tmuxRowOwnership,
  sendText as tmuxSendText,
  setRemainOnExit as tmuxSetRemainOnExit,
  sleep,
  tailCaptureLines,
  tailWindow,
  targetAlive as tmuxTargetAlive,
  targetLive as tmuxTargetLive,
  targetLiveProbe as tmuxTargetLiveProbe,
  targetPid as tmuxTargetPid,
  tmux,
  tmuxSocketPath,
  tmuxWithClientPath,
  waitForPaneEstablished as tmuxWaitForPaneEstablished,
  waitForPaneInput as tmuxWaitForPaneInput,
  type AliveSnapshot,
  type InputBoxSnapshot,
  type InputBoxState,
  type Liveness,
  type PaneProbe,
  type PaneReadinessOutcome,
  type RowOwnership,
  type RowPaneIdentity,
  type TrailerView,
} from "./tmux.js";

export type { Terminal } from "./globalConfig.js";

export {
  adoptableWindow,
  appendGlobalHook,
  applyLayout,
  claimInitialWindow,
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
  rex?: {
    projectId: number;
    projectName: string;
    agentId?: number;
    record: (placed: { target: string; pid: string }) => void;
    orphaned?: (detail: string) => void;
  };
}

let rexInUseProbe: () => boolean = () => false;

export function registerRexInUse(probe: () => boolean): void {
  rexInUseProbe = probe;
}

export function rexActive(): boolean {
  try {
    return rexInUseProbe();
  } catch {
    return false;
  }
}

const callerInRex = (): boolean => !!process.env.REX_BLOCK && !process.env.TMUX && rexActive();

export const callerPane = (): string => (callerInRex() ? process.env.REX_BLOCK ?? "" : process.env.TMUX_PANE ?? "");

export const callerTmuxSocket = (): string => tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);

export const callerSocket = (): string => {
  const server = callerInRex() ? defaultRexServer() : null;
  return server ? `rex:${server}` : callerTmuxSocket();
};

export const callerTmuxTmpDir = (): string | undefined => process.env.TMUX_TMPDIR;

export const insideTerminal = (): boolean => !!process.env.TMUX;

export function killPane(target: string): void {
  if (isRexTarget(target)) return rexClose(target);
  tmux("kill-pane", "-t", target);
}

export function killWindow(target: string): void {
  if (isRexTarget(target)) return rexClose(target);
  tmux("kill-window", "-t", target);
}

export function splitPane({ argv, clientPath }: SplitArgs): { target: string; pid: string } {
  const out = clientPath === undefined ? tmux(...argv) : tmuxWithClientPath(clientPath, ...argv);
  const [target, pid = ""] = out.split("\t");
  return { target, pid };
}

export function respawnPane({ target, cwd, env, command, rex }: RespawnArgs): { target: string } {
  if (isRexTarget(target)) return rexRespawn(target, rexLeadSpec(rex, cwd, env, command), rex?.record, rex?.orphaned);
  tmux("respawn-pane", "-k", "-t", target, "-c", cwd, ...env, command);
  return { target };
}

export function callerIsOtherOwnedBlock(row: RowPaneIdentity & { command: string }): boolean {
  const caller = rexCallerBlock();
  if (!caller || !isRexTarget(row.tmux_target) || caller === row.tmux_target) return false;
  return rexOwnership(row) === "live";
}

function rexLeadSpec(rex: RespawnArgs["rex"], cwd: string, env: string[], command: string) {
  if (!rex) throw new Error("a Rex respawn needs the lead's project");
  return {
    projectId: rex.projectId, projectName: rex.projectName, label: `${rex.projectName}/lead`, cwd,
    env: envFromFlags(env), argv: commandArgv(command), placement: "lead" as const, retainOnExit: false, agentId: rex.agentId,
  };
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
  if (isRexTarget(target)) {
    rexSendKeys(target, keys);
    return;
  }
  tmux("send-keys", "-t", target, "--", ...keys);
}

export function interruptPane(target: string): void {
  if (isRexTarget(target)) return rexSendKey(target, "C-c");
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

export type TerminalSource = "env" | "project" | "global" | "default";

export function resolveTerminal(
  project: { terminal: Terminal | null } | null,
  warnings?: string[],
): { terminal: Terminal; source: TerminalSource } {
  const env = process.env.HIVE_TERMINAL;
  if (isTerminal(env)) return { terminal: env, source: "env" };
  if (env) warnings?.push(`HIVE_TERMINAL: terminal must be "tmux" or "rex"; ignoring "${env}".`);
  if (project?.terminal) return { terminal: project.terminal, source: "project" };
  const global = readGlobalConfig().root?.terminal;
  if (isTerminal(global)) return { terminal: global, source: "global" };
  return { terminal: "tmux", source: "default" };
}

export const terminalOfRow = (row: { tmux_target: string; tmux_socket: string }): Terminal =>
  isRexTarget(row.tmux_target ?? "") || isRexSocket(row.tmux_socket ?? "") ? "rex" : "tmux";

export interface TerminalSnapshot extends AliveSnapshot {
  rex?: RexSnapshot | null;
}

const rexRow = (socket: string, target: string): boolean => isRexTarget(target ?? "") || isRexSocket(socket ?? "");

const rexOf = (snapshot: AliveSnapshot | null | undefined): RexSnapshot | null | undefined =>
  snapshot ? (snapshot as TerminalSnapshot).rex : undefined;

export function liveTargets(): TerminalSnapshot | null {
  const snapshot: TerminalSnapshot | null = tmuxLiveTargets();
  if (snapshot === null || !rexActive()) return snapshot;
  snapshot.rex = rexSnapshot();
  return snapshot;
}

const BLOCKING_STATUS_KINDS = new Set(["permission", "question", "auth"]);

export function programStatusBlocks(target: string, snap: TerminalSnapshot | null | undefined): boolean {
  if (!isRexTarget(target)) return false;
  const status = rexOf(snap)?.blocks.get(target)?.status;
  if (!status) return false;
  return status.state === "blocked" || (status.kind !== null && BLOCKING_STATUS_KINDS.has(status.kind));
}

export function rowSnapshot(row: RowPaneIdentity): TerminalSnapshot | undefined {
  if (!rexRow(row.tmux_socket, row.tmux_target) || row.tmux_target === "") return undefined;
  const rex = rexSnapshot(rexServerFor(row.tmux_socket, row.tmux_target), [row.tmux_target]);
  return { panes: new Set(), windows: new Set(), pids: new Map(), rex };
}

export const foreignSocket = (recorded: string): boolean => (isRexSocket(recorded) ? false : tmuxForeignSocket(recorded));

export function rowOwnership(row: RowPaneIdentity, snapshot?: AliveSnapshot | null): RowOwnership {
  if (rexRow(row.tmux_socket, row.tmux_target)) return rexOwnership(row, rexOf(snapshot));
  return tmuxRowOwnership(row, snapshot);
}

export function observeRowOwnership(row: RowPaneIdentity): RowOwnership | "probe-failed" {
  if (!rexRow(row.tmux_socket, row.tmux_target)) return tmuxObserveRowOwnership(row);
  if (row.tmux_target === "") return "gone";
  const snap = rexSnapshot(rexServerFor(row.tmux_socket, row.tmux_target), [row.tmux_target]);
  return snap === null ? "probe-failed" : rexOwnership(row, snap);
}

const rexServerFor = (socket: string, target: string): string | null =>
  isRexSocket(socket) ? rexServerOf(socket) : serverForTarget(target);

export function reapExitedBlock(row: { id: number; project_id: number; tmux_target: string; tmux_socket: string }, snapshot: AliveSnapshot | null): void {
  if (!rexRow(row.tmux_socket, row.tmux_target) || !row.tmux_target) return;
  rexForgetShownAs(row.project_id, row.tmux_target);
  rexReapExited(row, row.tmux_target, rexServerFor(row.tmux_socket, row.tmux_target), rexOf(snapshot));
}

export function reapPendingBlocks(snapshot: AliveSnapshot | null): void {
  if (rexActive()) rexReapPending(rexOf(snapshot));
}

export function targetLiveProbe(target: string): PaneProbe {
  return isRexTarget(target) ? rexRowProbe("", target) : tmuxTargetLiveProbe(target);
}

export function targetLive(target: string): Liveness {
  return isRexTarget(target) ? rexRowProbe("", target).live : tmuxTargetLive(target);
}

export function rowLiveProbe(recordedSocket: string, target: string): PaneProbe {
  return rexRow(recordedSocket, target) ? rexRowProbe(recordedSocket, target) : tmuxRowLiveProbe(recordedSocket, target);
}

export function rowLive(recordedSocket: string, target: string): Liveness {
  return rexRow(recordedSocket, target) ? rexRowProbe(recordedSocket, target).live : tmuxRowLive(recordedSocket, target);
}

export function rowAliveProbe(recordedSocket: string, target: string, snapshot: AliveSnapshot): PaneProbe {
  if (rexRow(recordedSocket, target)) return rexRowProbe(recordedSocket, target, rexOf(snapshot));
  return tmuxRowAliveProbe(recordedSocket, target, snapshot);
}

export function rowAlive(recordedSocket: string, target: string, snapshot: AliveSnapshot): Liveness {
  if (rexRow(recordedSocket, target)) return rexRowProbe(recordedSocket, target, rexOf(snapshot)).live;
  return tmuxRowAlive(recordedSocket, target, snapshot);
}

export function targetAlive(target: string, snapshot: AliveSnapshot): boolean {
  return isRexTarget(target) ? rexBlockAlive(target, rexOf(snapshot)) !== false : tmuxTargetAlive(target, snapshot);
}

export function targetPid(target: string, snapshot: AliveSnapshot): string | null {
  if (!isRexTarget(target)) return tmuxTargetPid(target, snapshot);
  return rexOf(snapshot)?.blocks.get(target)?.pid || null;
}

export function panePid(target: string): string {
  return isRexTarget(target) ? (rexProbe(target).pid ?? "") : tmuxPanePid(target);
}

export function panePidForRecord(target: string): string {
  return isRexTarget(target) ? panePid(target) || panePid(target) : tmuxPanePidForRecord(target);
}

export function paneProcessExited(target: string): boolean | null {
  if (!isRexTarget(target)) return tmuxPaneProcessExited(target);
  const probe = rexProbe(target);
  return probe.live === null ? null : probe.live === false || probe.exited;
}

export function paneInCopyMode(target: string): boolean | null {
  return isRexTarget(target) ? false : tmuxPaneInCopyMode(target);
}

export function cancelCopyMode(target: string): boolean {
  return isRexTarget(target) ? false : tmuxCancelCopyMode(target);
}

export function paneCurrentCommand(target: string): string | null {
  return isRexTarget(target) ? rexProbe(target).argv : tmuxPaneCurrentCommand(target);
}

export function paneTitle(target: string): string | null {
  return isRexTarget(target) ? rexTitle(target) : tmuxPaneTitle(target);
}

export function captureRawPane(target: string, lines: number): string {
  return isRexTarget(target) ? rexCapture(target, lines, false) : tmuxCaptureRawPane(target, lines);
}

export function capturePane(target: string, lines: number): string {
  return isRexTarget(target) ? tailWindow(rexCapture(target, lines, false), lines) : tmuxCapturePane(target, lines);
}

const styledTail = (target: string): string => rexCapture(target, tailCaptureLines(), true);

function rexScreen<T>(read: () => T, failed: T): T {
  try {
    return read();
  } catch {
    return failed;
  }
}

export function inputBoxSnapshot(target: string): InputBoxSnapshot | null {
  if (!isRexTarget(target)) return tmuxInputBoxSnapshot(target);
  return rexScreen(() => inputBoxSnapshotFromRaw(styledTail(target)), null);
}

export const inputBoxState = (target: string): InputBoxState | null => inputBoxSnapshot(target)?.box ?? null;

export function claudeTrailerView(target: string): TrailerView | null {
  if (!isRexTarget(target)) return tmuxClaudeTrailerView(target);
  return rexScreen(() => claudeTrailerViewFromRaw(styledTail(target)), null);
}

const NO_CHOICE_READING = (): { awaitingChoice: boolean | null; tail: string } => ({ awaitingChoice: null, tail: "" });

export function paneChoiceCheck(target: string): { awaitingChoice: boolean | null; tail: string } {
  if (!isRexTarget(target)) return tmuxPaneChoiceCheck(target);
  return rexScreen(() => paneChoiceCheckFromRaw(rexCapture(target, tailCaptureLines(), false)), NO_CHOICE_READING());
}

export function paneAwaitingChoice(target: string): boolean | null {
  return isRexTarget(target) ? paneChoiceCheck(target).awaitingChoice : tmuxPaneAwaitingChoice(target);
}

export function codexInputBoxState(target: string): InputBoxState | null {
  if (!isRexTarget(target)) return tmuxCodexInputBoxState(target);
  return rexScreen(() => codexInputBoxStateFromRaw(styledTail(target), null), null);
}

export function codexTrailerView(target: string): TrailerView | null {
  if (!isRexTarget(target)) return tmuxCodexTrailerView(target);
  return rexScreen(() => codexTrailerViewFromRaw(styledTail(target)), null);
}

export function codexPaneChoiceCheck(target: string): { awaitingChoice: boolean | null; tail: string } {
  if (!isRexTarget(target)) return tmuxCodexPaneChoiceCheck(target);
  return rexScreen(
    () => codexPaneChoiceCheckFromRaw(rexCapture(target, tailCaptureLines(), false), rexTitle(target)),
    NO_CHOICE_READING(),
  );
}

export const paneHasInputBox = (target: string): boolean | null => {
  if (!isRexTarget(target)) return tmuxPaneHasInputBox(target);
  return rexScreen(() => findInputBox(capturePane(target, tailCaptureLines()).split("\n"))?.prompt != null, null);
};

export const codexPaneHasInputBox = (target: string): boolean | null => {
  if (!isRexTarget(target)) return tmuxCodexPaneHasInputBox(target);
  return rexScreen(() => findCodexPromptBox(capturePane(target, tailCaptureLines()).split("\n")) !== null, null);
};

const rexHasInputBox = (target: string): boolean | null =>
  rexScreen(() => findInputBox(capturePane(target, 30).split("\n"))?.prompt != null, null);

export async function pollPaneReadiness(
  target: string,
  timeoutMs: number,
  hasInputBox?: (target: string) => boolean | null,
): Promise<PaneReadinessOutcome> {
  if (!isRexTarget(target)) return tmuxPollPaneReadiness(target, timeoutMs, hasInputBox);
  const check = hasInputBox ?? rexHasInputBox;
  const start = Date.now();
  while (Date.now() < start + timeoutMs) {
    if (paneProcessExited(target) === true) return "gone";
    if (check(target) === true) {
      await sleep(250);
      return "ready";
    }
    await sleep(Date.now() - start < 1000 ? 200 : 500);
  }
  return "timeout";
}

export async function waitForPaneInput(
  target: string,
  timeoutMs: number,
  hasInputBox?: (target: string) => boolean | null,
): Promise<boolean> {
  if (!isRexTarget(target)) return tmuxWaitForPaneInput(target, timeoutMs, hasInputBox);
  return (await pollPaneReadiness(target, timeoutMs, hasInputBox)) === "ready";
}

export function waitForPaneEstablished(
  target: string,
  timeoutMs?: number,
  probe?: (pid: string) => boolean,
  pidLookup?: (target: string) => string,
): void {
  if (isRexTarget(target)) return;
  tmuxWaitForPaneEstablished(target, timeoutMs, probe, pidLookup);
}

export function setRemainOnExit(target: string, on: boolean): void {
  if (isRexTarget(target)) return;
  tmuxSetRemainOnExit(target, on);
}

export function captureFinalScreen(target: string, lines: number): string {
  if (!isRexTarget(target)) return tmuxCaptureFinalScreen(target, lines);
  return rexScreen(
    () => rexCapture(target, Math.max(lines * 10, 200), false).split("\n").filter((row) => row.trim() !== "").slice(-lines).join("\n"),
    "",
  );
}

export const sendText = async (
  target: string,
  text: string,
  submit = true,
  onPasted?: () => void,
  onBuffered?: () => void,
  beforePaneWrite?: () => void,
): Promise<void> => {
  if (!isRexTarget(target)) return tmuxSendText(target, text, submit, onPasted, onBuffered, beforePaneWrite);
  return rexSendText(target, text, { submit, onPasted, onBuffered, beforePaneWrite });
};
