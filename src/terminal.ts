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
} from "./tmux.js";

export const isRexTarget = (target: string): boolean => target.startsWith("block:");

export const isRexSocket = (socket: string): boolean => socket.startsWith("rex:");

export const rexServerOf = (socket: string): string => socket.replace(/^rex:/, "");
