export const REX_REFUSAL = "the Rex terminal is not available in this build; set HIVE_TERMINAL=tmux";

export class RexNotImplemented extends Error {
  constructor(readonly operation: string) {
    super(REX_REFUSAL);
    this.name = "RexNotImplemented";
  }
}

const refuse = (operation: string): never => {
  throw new RexNotImplemented(operation);
};

export const startLead = (): never => refuse("startLead");
export const spawnWorker = (): never => refuse("spawnWorker");
export const startProcess = (): never => refuse("startProcess");
export const respawnLead = (): never => refuse("respawnLead");
export const snapshot = (): never => refuse("snapshot");
